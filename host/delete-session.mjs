import { lstat, mkdtemp, readdir, realpath, rename, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const failure = (code, message) => ({ ok: false, error: { code, message } })
const MAX_REQUEST_BYTES = 8 * 1024

/* ------------------------------------------------------------------ */
/* Agent-lifecycle tracking                                            */
/* ------------------------------------------------------------------ */

/**
 * Shared tracker state, kept on `globalThis` so it survives a plugin reload.
 * DSH keeps every resumed Agent loaded for the whole Host-process lifetime,
 * while reloading this plugin disposes its Cordis effects. A module-local
 * handle map therefore forgot exactly the sessions it had loaded, and the next
 * deletion of one of them was refused as "still loaded by the Host". The map
 * and the in-flight deletion reservations live here instead, and the service
 * wrappers are installed once per Host process.
 */
const TRACKER_STATE = Symbol.for('dsh-original-version-enhancements.agent-tracker.v1')
const TRACKER_INSTALLED = Symbol.for('dsh-original-version-enhancements.agent-tracker.installed.v1')

/** @returns the process-wide handle map and deletion reservations. */
const sharedTrackerState = () => {
  const current = globalThis[TRACKER_STATE]
  if (current !== undefined && current.handles instanceof Map && current.reservations instanceof Set) return current
  const created = { handles: new Map(), reservations: new Set() }
  globalThis[TRACKER_STATE] = created
  return created
}

/** Read the live Agent without letting a disposed service fail the deletion. */
const liveAgentOf = (agents, sessionId) => {
  try {
    return typeof agents?.get === 'function' ? agents.get(sessionId) : undefined
  } catch {
    return undefined
  }
}

/**
 * Retain the lifecycle capability returned by the public AgentFactory so a
 * loaded session can be stopped and detached before its storage is removed.
 * Adapted from dsh-chat-manager v1.5.21.
 * @param agents - the Host agent registry.
 * @param sessions - the Host session store.
 * @returns reserve/dispose/release hooks used by the deletion path.
 */
export function installAgentHandleTracker(agents, sessions) {
  const state = sharedTrackerState()
  const originalSymbol = Symbol.for('cordis.original')
  const agentService = agents?.[originalSymbol] ?? agents
  const sessionService = sessions?.[originalSymbol] ?? sessions

  const assertAvailable = (sessionId) => {
    if (typeof sessionId === 'string' && state.reservations.has(sessionId)) {
      throw new Error(`session "${sessionId}" is being permanently deleted`)
    }
  }

  const remember = (handle) => {
    const id = handle?.agent?.id
    if (typeof id !== 'string' || typeof handle.dispose !== 'function') return handle
    state.handles.set(id, handle)
    // Handles are single-shot: drop those whose Agent has already gone so a
    // long-lived Host process cannot accumulate them.
    if (state.handles.size > 64) {
      for (const [trackedId, tracked] of state.handles) {
        if (tracked !== handle && liveAgentOf(agents, trackedId) !== tracked.agent) state.handles.delete(trackedId)
      }
    }
    return handle
  }

  if (agentService !== undefined && agentService[TRACKER_INSTALLED] !== true) {
    const originalCreate = agentService.create
    const originalResume = agentService.resume
    const originalAgentEnter = agentService.enter
    const originalSessionEnter = sessionService?.enter
    const wrappedCreate = async function (...args) {
      assertAvailable(args[0]?.sessionId)
      return remember(await Reflect.apply(originalCreate, this, args))
    }
    const wrappedResume = async function (...args) {
      assertAvailable(args[0]?.resumeSessionId)
      return remember(await Reflect.apply(originalResume, this, args))
    }
    const wrappedAgentEnter = typeof originalAgentEnter === 'function'
      ? function (...args) {
          assertAvailable(args[0]?.id)
          return Reflect.apply(originalAgentEnter, this, args)
        }
      : undefined
    const wrappedSessionEnter = typeof originalSessionEnter === 'function'
      ? function (...args) {
          assertAvailable(args[0]?.id)
          return Reflect.apply(originalSessionEnter, this, args)
        }
      : undefined

    Object.defineProperty(agentService, TRACKER_INSTALLED, { value: true, configurable: true })
    if (typeof originalCreate === 'function') agentService.create = wrappedCreate
    if (typeof originalResume === 'function') agentService.resume = wrappedResume
    if (wrappedAgentEnter !== undefined) agentService.enter = wrappedAgentEnter
    if (wrappedSessionEnter !== undefined) sessionService.enter = wrappedSessionEnter
  }

  return {
    reserve(sessionId) {
      if (state.reservations.has(sessionId)) return undefined
      state.reservations.add(sessionId)
      let active = true
      return () => {
        if (!active) return
        active = false
        state.reservations.delete(sessionId)
      }
    },
    async dispose(sessionId) {
      const handle = state.handles.get(sessionId)
      if (handle === undefined) return false
      const live = liveAgentOf(agents, sessionId)
      if (live !== undefined && live !== handle.agent) {
        // A later lifecycle replaced the Agent this handle owns, so the handle
        // can no longer stop what is running under this id.
        state.handles.delete(sessionId)
        return false
      }
      state.handles.delete(sessionId)
      await handle.dispose()
      return true
    },
    // Handles intentionally outlive this plugin generation: releasing them
    // would put the Host back into the state that made deletion fail after a
    // reload. The wrappers only record capabilities and never act on their own.
    release() {},
  }
}

const sendJson = (res, status, body) => {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(body))
}

const readJsonBody = async (req) => {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_REQUEST_BYTES) throw new Error('request-too-large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

const sameHeader = (left, right) => (
  left?.id === right?.id
  && left?.version === right?.version
  && left?.createdAt === right?.createdAt
  && left?.cwd === right?.cwd
  && left?.parentSession === right?.parentSession
  && left?.seedLength === right?.seedLength
  && left?.origin === right?.origin
  && (left?.delegationDepth ?? 0) === (right?.delegationDepth ?? 0)
  && left?.agentPreset === right?.agentPreset
  && left?.isSeeded === right?.isSeeded
)

const inside = (root, target) => {
  const path = relative(root, target)
  return path !== '' && !path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path)
}

const missing = error => error?.code === 'ENOENT'

const sameFile = (left, right) => (
  left.dev === right.dev
  && left.ino === right.ino
  && left.mode === right.mode
  && left.size === right.size
  && left.birthtimeNs === right.birthtimeNs
)

const locationPaths = (sessionRoot, location) => {
  if (location?.kind !== 'jsonl' || typeof location.path !== 'string') return undefined
  const root = resolve(sessionRoot)
  const transcript = resolve(location.path)
  if (!isAbsolute(root) || !isAbsolute(transcript) || !inside(root, transcript)) return undefined
  const parts = relative(root, transcript).split(sep).filter(Boolean)
  if (parts.length !== 3 || !/^session(?:\.v[1-9]\d*)?\.jsonl(?:\.zstd)?$/.test(parts[2])) return undefined
  return {
    root,
    projectDirectory: join(root, parts[0]),
    sessionDirectory: join(root, parts[0], parts[1]),
    transcript,
  }
}

const validateExistingLocation = async (paths) => {
  const [root, project, directory, transcript] = await Promise.all([
    realpath(paths.root),
    lstat(paths.projectDirectory, { bigint: true }),
    lstat(paths.sessionDirectory, { bigint: true }),
    lstat(paths.transcript, { bigint: true }),
  ])
  if (
    !project.isDirectory()
    || project.isSymbolicLink()
    || !directory.isDirectory()
    || directory.isSymbolicLink()
    || !transcript.isFile()
    || transcript.isSymbolicLink()
  ) return undefined

  const [resolvedProject, resolvedDirectory, resolvedTranscript] = await Promise.all([
    realpath(paths.projectDirectory),
    realpath(paths.sessionDirectory),
    realpath(paths.transcript),
  ])
  if (
    !inside(root, resolvedProject)
    || !inside(root, resolvedDirectory)
    || dirname(resolvedTranscript) !== resolvedDirectory
  ) return undefined
  return { root, resolvedDirectory, directory, transcript }
}

/**
 * Stop a session whose storage never materialized from blocking its own
 * deletion. An interrupted write can leave the session directory behind with no
 * transcript inside it; such a session is listed by the Workspace accounting but
 * can never be opened, and the ordinary path refuses it as "not found" because
 * there is no header or log to validate.
 * @param sessionRoot - the persistence root every transcript lives under.
 * @param sessionId - the session whose directory is wanted.
 * @returns the validated project root and session directory, or undefined.
 */
const findPhantomSessionDirectories = async (sessionRoot, sessionId) => {
  let root
  try {
    root = await realpath(sessionRoot)
  } catch {
    return []
  }
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const found = []
  for (const project of projects) {
    if (!project.isDirectory() || project.isSymbolicLink()) continue
    const candidate = join(root, project.name, sessionId)
    let info
    try {
      info = await lstat(candidate, { bigint: true })
    } catch {
      continue
    }
    if (!info.isDirectory() || info.isSymbolicLink()) continue
    let resolved
    try {
      resolved = await realpath(candidate)
    } catch {
      continue
    }
    if (!inside(root, resolved)) continue
    let entries
    try {
      entries = await readdir(resolved)
    } catch {
      continue
    }
    // A real log is handled by the ordinary location path; only an empty
    // storage shell takes this branch.
    if (entries.some(name => /^session(?:\.v[1-9]\d*)?\.jsonl(?:\.zstd)?$/.test(name))) continue
    found.push({ root, resolvedDirectory: resolved, identity: info })
  }
  return found
}

/**
 * Remove every empty storage shell carrying one session id. Interrupted writes
 * can leave a shell in more than one project directory, and deleting only the
 * first is what made a removed conversation come back. The tree is scanned
 * again after each pass, so a shell that appeared during the removal is not
 * left behind either.
 * @param deps - removable directory hooks.
 * @param sessionRoot - the persistence root.
 * @param sessionId - the session whose shells should be removed.
 * @returns a tagged result, or undefined when there was nothing to remove.
 */
const removePhantomSessionDirectories = async (deps, sessionRoot, sessionId) => {
  let last
  for (let pass = 0; pass < 8; pass += 1) {
    const found = await findPhantomSessionDirectories(sessionRoot, sessionId).catch(() => [])
    if (found.length === 0) return last
    for (const phantom of found) {
      const result = await removePhantomDirectory(deps, phantom)
      if (result?.ok !== true) return result
      last = result
    }
  }
  return failure('storage-partial', '会话已从 DSH 摘载，但仍有残留的空存储目录，不能确认永久删除成功。')
}

/**
 * Remove a storage shell that holds no transcript, through the same quarantine
 * protocol as a real removal: the directory is renamed away first, re-checked,
 * and only then deleted, so a permission or identity failure never leaves a
 * half-removed directory behind.
 * @param deps - removable directory hooks.
 * @param phantom - the validated project root and session directory.
 * @returns a tagged result understood by the settings page.
 */
const removePhantomDirectory = async (deps, phantom) => {
  const moveDirectory = deps.moveDirectory ?? rename
  let quarantineRoot
  let quarantined
  let detached = false
  try {
    quarantineRoot = await mkdtemp(join(dirname(phantom.root), '.dsh-session-delete-'))
    quarantined = join(quarantineRoot, basename(phantom.resolvedDirectory))
    await moveDirectory(phantom.resolvedDirectory, quarantined)
    detached = true

    const after = await lstat(quarantined, { bigint: true })
    if (!after.isDirectory() || after.isSymbolicLink() || !sameFile(phantom.identity, after)) {
      await moveDirectory(quarantined, phantom.resolvedDirectory)
      detached = false
      await rm(quarantineRoot, { recursive: true, force: true })
      return failure('unsafe-location', '会话存储目录在删除期间发生了身份变化，未删除任何文件。')
    }

    const removeDirectory = deps.removeDirectory
      ?? (directory => rm(directory, { recursive: true, force: false }))
    await removeDirectory(quarantined)
    if (await pathExists(quarantined)) {
      return failure('storage-partial', '会话已从 DSH 摘载，但存储清理未完成，不能确认永久删除成功。')
    }
    await rm(quarantineRoot, { recursive: true, force: true })
    return { ok: true, value: { deleted: true, phantom: true } }
  } catch (error) {
    if (detached && quarantined !== undefined) {
      let remains = true
      try {
        remains = await pathExists(quarantined)
      } catch {
        // Inaccessible storage is not proof of cleanup; retain the quarantine.
      }
      if (remains) {
        return failure('storage-partial', '会话已从 DSH 摘载，但存储清理未完成，不能确认永久删除成功。')
      }
      if (quarantineRoot !== undefined) await rm(quarantineRoot, { recursive: true, force: true }).catch(() => undefined)
      return { ok: true, value: { deleted: true, phantom: true } }
    }
    if (quarantineRoot !== undefined) await rm(quarantineRoot, { recursive: true, force: true }).catch(() => undefined)
    if (missing(error)) return failure('session-not-found', '会话不存在或已经删除。')
    return failure('storage-error', '存储删除失败，未删除任何文件。')
  }
}

const pathExists = async (path) => {
  try {    await lstat(path)
    return true
  } catch (error) {
    if (missing(error)) return false
    throw error
  }
}

/**
 * Stop and detach a session the Host still holds open, so its storage can be
 * removed or moved. A session opened before the last plugin reload has no
 * retained lifecycle handle; it is reported instead of pretending it unloaded.
 * @param deps - sessions/agents services plus the retained lifecycle handles.
 * @param sessionId - the session to stop.
 * @returns undefined on success, or a tagged failure understood by the caller.
 */
export async function stopLoadedSession(deps, sessionId) {
  if (deps.agents.get(sessionId) === undefined) return undefined
  let disposed = false
  if (typeof deps.agentHandles?.dispose === 'function') {
    try {
      disposed = await deps.agentHandles.dispose(sessionId)
    } catch {
      return failure('lifecycle-error', 'DSH 未能安全停止并摘载该会话，未删除任何内容。')
    }
  }
  if (disposed) return undefined
  return failure(
    'lifecycle-unavailable',
    '该会话仍被宿主加载，而插件没有它的生命周期句柄（通常是宿主上次重载插件之前就已打开的会话）。可以「强制删除」，或重启 DeepSeek Harness 后重试。',
  )
}

/**
 * Permanently remove one unloaded JSONL session directory. A loaded Agent is
 * refused before any storage check; the caller must stop and archive it first.
 * @param deps - sessions, agents and the JSONL persistence backend.
 * @param target - the session root and the exact session id.
 * @returns a tagged result understood by the settings page.
 */
export async function deleteSessionSafely(deps, { sessionRoot, sessionId, force = false }) {
  const releaseReservation = deps.agentHandles?.reserve?.(sessionId)
  if (typeof deps.agentHandles?.reserve === 'function' && releaseReservation === undefined) {
    return failure('deletion-in-progress', '该会话正在删除中，请等待当前操作完成。')
  }

  let result
  try {
    result = await deleteSessionStorage(deps, { sessionRoot, sessionId, force })
  } finally {
    releaseReservation?.()
  }
  // The transcript standing alone is not the whole record: the Workspace
  // registry would keep listing its id (a ghost conversation) and the
  // projection cache would keep its last title. Both are dropped here — after
  // the storage lease is released, so a dispose-triggered checkpoint cannot
  // resurrect the cache row — and never at the cost of reporting a failed delete.
  if (result.ok) await purgeSessionAccounting(deps, sessionId)
  return result
}

/**
 * Remove one session for a caller that already owns the session's deletion
 * reservation (for example the transfer rollback, which must not deadlock on
 * its own move reservation). Accounting is purged here too, because the caller
 * may never reach its normal success path.
 * @param deps - sessions, agents and the JSONL persistence backend.
 * @param target - the session root and the exact session id.
 * @returns a tagged result understood by the settings page.
 */
export async function deleteSessionWithoutReservation(deps, { sessionRoot, sessionId, force = false, purge = true }) {
  const result = await deleteSessionStorage(deps, { sessionRoot, sessionId, force })
  // A transfer rollback removes a copy whose files were never filed anywhere:
  // purging accounting would detach the *source* workspace while a failed move
  // is still restoring the original log under the same id.
  if (result.ok && purge) await purgeSessionAccounting(deps, sessionId)
  return result
}

/**
 * Remove one session's storage, without touching the reservation set.
 * @param deps - sessions, agents and the JSONL persistence backend.
 * @param target - the session root, id and whether to bypass the load check.
 * @returns a tagged result understood by the settings page.
 */
const deleteSessionStorage = async (deps, { sessionRoot, sessionId, force }) => {
  const persistence = deps.sessionPersistence
  const usesHandles = persistence.supportsRawArtifacts === undefined
    && persistence.name === 'session-persistence-jsonl'
    && typeof persistence.open === 'function'
    && typeof persistence.stat === 'function'
    && typeof persistence.resolveCurrentLog === 'function'
  if (!persistence.supportsRawArtifacts && !usesHandles) {
    return failure('unsupported-backend', '当前会话存储不是可逐会话删除的 JSONL 后端。')
  }

  const ownership = { usesHandles, handle: undefined, force }
  try {
    return await deleteReservedSession(deps, { sessionRoot, sessionId }, ownership)
  } finally {
    try { await ownership.handle?.close() } catch { /* the lease is already gone */ }
  }
}

const UNLOAD_POLL_MS = 50

/**
 * Wait until neither the session store nor the agent registry still holds the
 * session. A handle's teardown awaits its own detach, but registry listeners
 * can settle a tick later; polling briefly avoids reporting "still loaded" for
 * a deletion that already completed.
 * @param deps - sessions/agents services plus an optional test timeout.
 * @param sessionId - the session to wait for.
 * @param timeoutMs - upper bound for the wait.
 * @returns whether both registries released the session.
 */
const waitForUnload = async (deps, sessionId, timeoutMs) => {
  const unloaded = () => {
    try {
      return deps.sessions.get(sessionId) === undefined && deps.agents.get(sessionId) === undefined
    } catch {
      return false
    }
  }
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (unloaded()) return true
    if (Date.now() >= deadline) return false
    await new Promise(resolveTimeout => setTimeout(resolveTimeout, UNLOAD_POLL_MS))
  }
}

async function deleteReservedSession(deps, { sessionRoot, sessionId }, ownership) {
  const { usesHandles, force } = ownership
  const storedHeaders = async () => (await deps.sessionPersistence.list()).map(item => usesHandles ? item.header : item)
  const snapshot = usesHandles
    ? await deps.sessionPersistence.stat(sessionId).catch(() => undefined)
    : undefined
  let header = (await storedHeaders()).find(item => item.id === sessionId)
    ?? snapshot?.header
    ?? deps.sessions.get(sessionId)?.header
  if (header === undefined) {
    // A stale archive marker can outlive its transcript. A session whose storage
    // is a hollow directory shell is removed here: it can never be opened, so
    // refusing it would strand it in the sidebar forever.
    if (usesHandles && /^[A-Za-z0-9_-]+$/.test(sessionId)
      && deps.sessions.get(sessionId) === undefined && deps.agents.get(sessionId) === undefined
      && await deps.sessionPersistence.stat(sessionId) === undefined) {
      const removed = await removePhantomSessionDirectories(deps, sessionRoot, sessionId).catch(() => undefined)
      if (removed !== undefined) return removed
      const projects = await readdir(sessionRoot, { withFileTypes: true })
      let absent = true
      for (const project of projects) {
        if (project.isSymbolicLink()) { absent = false; break }
        if (!project.isDirectory()) continue
        const entries = await readdir(join(sessionRoot, project.name))
        if (entries.some(name => name === sessionId || name.startsWith(`${sessionId}.`))) {
          absent = false; break
        }
      }
      if (absent && await deps.sessionPersistence.stat(sessionId) === undefined
        && deps.sessions.get(sessionId) === undefined && deps.agents.get(sessionId) === undefined) {
        return { ok: true, value: { deleted: false, alreadyAbsent: true } }
      }
    }
    return failure('session-not-found', '会话不存在或已经删除。')
  }

  // A historical or corrupt log is deliberately NOT refused: opening it for the
  // write-lease proof would publish a migration, and a log that cannot be opened
  // at all would become undeletable. The removal below locates the artifact
  // without a write lease and still validates the directory before quarantining.

  if (!force) {
    const blocked = await stopLoadedSession(deps, sessionId)
    if (blocked !== undefined) return blocked
  }

  // Registry teardown can trail the handle's own detach by a tick; wait for it
  // instead of refusing a deletion whose unload is already under way.
  if (!force && !await waitForUnload(deps, sessionId, deps.unloadTimeoutMs ?? 4000)) {
    return failure('lifecycle-unavailable', '宿主没有在限期内完整摘载该会话，未删除任何内容。请稍后重试。')
  }

  // A session whose storage is an empty shell holds no transcript, so no read or
  // write lease can ever locate it: remove the shell rather than failing to
  // locate a log that is gone. Healthy sessions return here without a change.
  const shell = await removePhantomSessionDirectories(deps, sessionRoot, sessionId).catch(() => undefined)
  if (shell !== undefined) return shell

  let location
  let raw
  let openedForWrite = false
  if (force) {
    // The loaded session still holds the writer lease, so the exclusive open
    // cannot be acquired; the observed snapshot locates the artifact without it.
    location = usesHandles
      ? {
          kind: 'jsonl',
          path: snapshot?.location?.kind === 'jsonl' && typeof snapshot.location.path === 'string'
            ? snapshot.location.path
            : await deps.sessionPersistence.resolveCurrentLog(sessionId),
        }
      : deps.sessionPersistence.locate(header)
    raw = { meta: header }
  } else if (snapshot?.formatStatus !== undefined && snapshot.formatStatus !== 'current') {
    // A historical log must not be opened for writing: that publishes a
    // migration of a file we are about to remove. It is also exactly the kind of
    // record the user otherwise cannot get rid of, so locate it without a lease.
    try {
      location = usesHandles
        ? {
            kind: 'jsonl',
            path: snapshot?.location?.kind === 'jsonl' && typeof snapshot.location.path === 'string'
              ? snapshot.location.path
              : await deps.sessionPersistence.resolveCurrentLog(sessionId),
          }
        : deps.sessionPersistence.locate(header)
    } catch {
      return failure('storage-state-unknown', '无法定位该会话的存储位置，未删除任何文件。')
    }
    raw = { meta: header }
  } else {
    // inspect() waits for the persistence backend's asynchronous retirement
    // drain. A never-materialized blank session is already fully removed here.
    try {
      const inspected = usesHandles
        ? { meta: (ownership.handle = await deps.sessionPersistence.open(sessionId, 'write')).header }
        : await deps.sessionPersistence.inspect(sessionId)
      if (!sameHeader(header, inspected.meta)) {
        return failure('unsafe-location', '会话在摘载期间发生了身份变化，未删除任何文件。')
      }
      header = inspected.meta
      openedForWrite = true
    } catch (error) {
      const stillStored = (await storedHeaders()).some(item => item.id === sessionId)
      if (!stillStored && deps.sessions.get(sessionId) === undefined && deps.agents.get(sessionId) === undefined) {
        if (usesHandles && await deps.sessionPersistence.stat(sessionId) === undefined) {
          return { ok: true, value: { deleted: true } }
        }
        const missingPaths = usesHandles ? undefined : locationPaths(sessionRoot, deps.sessionPersistence.locate(header))
        if (missingPaths !== undefined && !await pathExists(missingPaths.sessionDirectory)) {
          return { ok: true, value: { deleted: true } }
        }
        return failure('storage-state-unknown', 'DSH 已摘载会话，但无法确认其存储是否已删除。')
      }
      if (!stillStored) {
        return failure('storage-state-unknown', '无法确认会话存储状态，未继续删除。')
      }
      // The stored log cannot be opened for writing: it is corrupt, an unsupported
      // historical format, or otherwise unreadable. Such a session can neither be
      // opened in the UI nor left behind forever, so locate its artifact without
      // the write lease; the location and quarantine checks below still decide
      // whether the removal is safe.
      try {
        location = usesHandles
          ? {
              kind: 'jsonl',
              path: snapshot?.location?.kind === 'jsonl' && typeof snapshot.location.path === 'string'
                ? snapshot.location.path
                : await deps.sessionPersistence.resolveCurrentLog(sessionId),
            }
          : deps.sessionPersistence.locate(header)
      } catch {
        return failure('storage-state-unknown', '无法定位该会话的存储位置，未删除任何文件。')
      }
      raw = { meta: header }
    }

    if (openedForWrite) {
      location = usesHandles
        ? { kind: 'jsonl', path: await deps.sessionPersistence.resolveCurrentLog(sessionId) }
        : deps.sessionPersistence.locate(header)
      raw = usesHandles ? { meta: ownership.handle.header } : await deps.sessionPersistence.readRaw(sessionId)
    }
  }

  const paths = locationPaths(sessionRoot, location)
  if (paths === undefined || raw === undefined || (!force && !sameHeader(header, raw.meta))) {
    // A header that survives its own log (an interrupted write, a hand-deleted
    // transcript) still leaves a removable storage shell behind.
    const removed = await removePhantomSessionDirectories(deps, sessionRoot, sessionId).catch(() => undefined)
    if (removed !== undefined) return removed
    return failure('unsafe-location', '无法验证该会话的独立 JSONL 存储位置。')
  }

  let validated
  try {
    validated = await validateExistingLocation(paths)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      const removed = await removePhantomSessionDirectories(deps, sessionRoot, sessionId).catch(() => undefined)
      if (removed !== undefined) return removed
      return failure('session-not-found', '会话不存在或已经删除。')
    }
    return failure('storage-error', '读取会话存储失败，未删除任何文件。')
  }
  if (validated === undefined) {
    const removed = await removePhantomSessionDirectories(deps, sessionRoot, sessionId).catch(() => undefined)
    if (removed !== undefined) return removed
    return failure('unsafe-location', '会话存储位置未通过安全校验，未删除任何文件。')
  }
  if (!force && (deps.sessions.get(sessionId) !== undefined || deps.agents.get(sessionId) !== undefined)) {
    return failure('session-reopened', '该会话在删除过程中被重新打开，已取消删除。')
  }

  let quarantineRoot
  let quarantinedDirectory
  let detached = false
  try {
    const moveDirectory = deps.moveDirectory ?? rename
    quarantineRoot = await mkdtemp(join(dirname(validated.root), '.dsh-session-delete-'))
    quarantinedDirectory = join(quarantineRoot, basename(validated.resolvedDirectory))
    await moveDirectory(validated.resolvedDirectory, quarantinedDirectory)
    detached = true

    const quarantinedTranscript = join(quarantinedDirectory, basename(paths.transcript))
    const [directoryAfter, transcriptAfter] = await Promise.all([
      lstat(quarantinedDirectory, { bigint: true }),
      lstat(quarantinedTranscript, { bigint: true }),
    ])
    if (
      directoryAfter.isSymbolicLink()
      || transcriptAfter.isSymbolicLink()
      || !sameFile(validated.directory, directoryAfter)
      || !sameFile(validated.transcript, transcriptAfter)
    ) {
      await moveDirectory(quarantinedDirectory, validated.resolvedDirectory)
      detached = false
      await rm(quarantineRoot, { recursive: true, force: true })
      return failure('unsafe-location', '会话目录在删除期间发生了身份变化，未删除任何文件。')
    }

    const removeDirectory = deps.removeDirectory
      ?? (directory => rm(directory, { recursive: true, force: false }))
    await removeDirectory(quarantinedDirectory)
    if (await pathExists(quarantinedDirectory)) {
      return failure('storage-partial', '会话已从 DSH 摘载，但存储清理未完成，不能确认永久删除成功。')
    }
    await rm(quarantineRoot, { recursive: true, force: true })
    return { ok: true, value: { deleted: true } }
  } catch (error) {
    if (detached && quarantinedDirectory !== undefined) {
      let remains = true
      try {
        remains = await pathExists(quarantinedDirectory)
      } catch {
        // Inaccessible storage is not proof of cleanup; retain the quarantine.
      }
      if (remains) {
        return failure('storage-partial', '会话已从 DSH 摘载，但存储清理未完成，不能确认永久删除成功。')
      }
      if (quarantineRoot !== undefined) await rm(quarantineRoot, { recursive: true, force: true }).catch(() => undefined)
      return { ok: true, value: { deleted: true } }
    }
    if (quarantineRoot !== undefined) await rm(quarantineRoot, { recursive: true, force: true }).catch(() => undefined)
    if (missing(error)) return failure('session-not-found', '会话不存在或已经删除。')
    return failure('storage-error', '存储删除失败，未删除任何文件。')
  }
}

/** Domain name of the persisted projection cache: one record per session id. */
const PROJECTION_DOMAIN = 'session_projcache'
const PROJECTION_TABLE = 'sessions'

/**
 * The live `sessions` table of the projection-cache domain: reached through the
 * cache service itself when it exposes the table, and otherwise through the
 * mounted storage domain. `delete`/`deleteMany` are the only way to drop a
 * cached record, so the listing cannot keep serving a removed session's title.
 * @param deps - the projection cache and storage domain services.
 * @returns the table, or undefined when this composition uses another medium.
 */
export function projectionCacheTable(deps) {
  const usable = table => table !== undefined
    && typeof table.delete === 'function'
    && typeof table.deleteMany === 'function'
    && typeof table.keys === 'function'
  const direct = deps.sessionProjectionCache?.table
  if (usable(direct)) return direct
  try {
    const table = deps.storageDomain?.get?.(PROJECTION_DOMAIN)?.table?.(PROJECTION_TABLE)
    if (usable(table)) return table
  } catch { /* an unmounted domain leaves the cache untouched */ }
  return undefined
}

/**
 * Drop a removed session's durable accounting. The transcript is only half the
 * record: the Workspace registry also accounts the id — which is exactly the
 * "ghost conversation" that stays listed until a restart — the archive and pin
 * sets may name it, and the projection cache holds its last title. This mirrors
 * the manual cleanup that used to be necessary.
 * Deliberately fail-soft: the transcript is already gone, so nothing here may
 * turn a completed removal into an error.
 * @param deps - the workspace registry, projection cache, and storage domain.
 * @param sessionId - the session whose accounting is stale.
 */
export async function purgeSessionAccounting(deps, sessionId) {
  const registry = deps.workspaceRegistry
  if (registry !== undefined) {
    try {
      for (const workspace of registry.list()) {
        try {
          await workspace.detachSession(sessionId)
        } catch { /* a failing write keeps the id for the startup reconciliation */ }
      }
    } catch { /* an unavailable registry is reconciled at the next start */ }
    try { await registry.unarchiveSession(sessionId) } catch { /* not archived, or unavailable */ }
    if (typeof registry.unpinSession === 'function') {
      try { await registry.unpinSession(sessionId) } catch { /* not pinned, or unavailable */ }
    }
  }
  const table = projectionCacheTable(deps)
  if (table !== undefined) {
    try { await table.delete(sessionId) } catch { /* the cache self-heals on its next write */ }
  }
}

/**
 * Freeze one source session for a move: the loaded Agent is stopped, the log is
 * read through a write lease (proving its identity and excluding other writers),
 * and the session directory is renamed out of the persistence root under the
 * same quarantine protocol as deletion. Recreating the session under the SAME id
 * afterwards therefore never exposes two logs for one id to the backend.
 * @param deps - sessions/agents/persistence hooks, optionally with moveDirectory.
 * @param request - the persistence root, the session id, and the header the caller read.
 * @returns the frozen header and events plus restore/discard handles, or a failure.
 */
export async function quarantineSessionForMove(deps, { sessionRoot, sessionId, expectedHeader }) {
  const persistence = deps.sessionPersistence
  const blocked = await stopLoadedSession(deps, sessionId)
  if (blocked !== undefined) {
    if (blocked.error?.code === 'lifecycle-unavailable') {
      return failure('lifecycle-unavailable', '该会话仍被宿主加载，请重启 DeepSeek Harness 后再移动，未做任何改动。')
    }
    return blocked
  }
  if (!await waitForUnload(deps, sessionId, deps.unloadTimeoutMs ?? 4000)) {
    return failure('lifecycle-unavailable', '宿主没有在限期内完整摘载该会话，未做任何改动。请稍后重试。')
  }

  const moveDirectory = deps.moveDirectory ?? rename
  let handle
  let detached = false
  let quarantineRoot
  let quarantined
  let validated
  let header
  let events

  try {
    handle = await persistence.open(sessionId, 'write')
    header = handle.header
    if (expectedHeader !== undefined && !sameHeader(header, expectedHeader)) {
      return failure('unsafe-location', '会话在摘载期间发生了身份变化，未做任何改动。')
    }
    const read = await handle.read()
    events = Array.isArray(read?.events) ? read.events : []
    const paths = locationPaths(sessionRoot, {
      kind: 'jsonl',
      path: await persistence.resolveCurrentLog(sessionId),
    })
    if (paths === undefined) return failure('unsafe-location', '无法验证该会话的独立 JSONL 存储位置。')
    validated = await validateExistingLocation(paths)
    if (validated === undefined) return failure('unsafe-location', '会话存储位置未通过安全校验，未做任何改动。')

    // Release the write lease (and drain anything it still holds) BEFORE the
    // directory moves, so no queued write can land on a renamed-away path.
    await handle.close()
    handle = undefined

    quarantineRoot = await mkdtemp(join(dirname(validated.root), '.dsh-session-move-'))
    quarantined = join(quarantineRoot, basename(validated.resolvedDirectory))
    await moveDirectory(validated.resolvedDirectory, quarantined)
    detached = true
    const after = await lstat(quarantined, { bigint: true })
    if (!after.isDirectory() || after.isSymbolicLink()) {
      await moveDirectory(quarantined, validated.resolvedDirectory)
      detached = false
      return failure('unsafe-location', '会话目录在移动期间发生了身份变化，未做任何改动。')
    }
  } catch (error) {
    if (detached && quarantined !== undefined && validated !== undefined) {
      try {
        await moveDirectory(quarantined, validated.resolvedDirectory)
        detached = false
      } catch { /* the returned quarantine path lets the user recover the log */ }
    }
    if (missing(error)) return failure('session-not-found', '会话不存在或已经删除。')
    return failure('storage-state-unknown', '无法读取该会话的存储，未做任何改动。')
  } finally {
    try { await handle?.close() } catch { /* releasing the lease is best-effort here */ }
    if (quarantineRoot !== undefined && !detached) {
      await rm(quarantineRoot, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  return {
    ok: true,
    value: {
      header,
      events,
      quarantine: {
        directory: quarantined,
        restore: async () => {
          if (!detached) return
          await moveDirectory(quarantined, validated.resolvedDirectory)
          detached = false
          await rm(quarantineRoot, { recursive: true, force: true }).catch(() => undefined)
        },
        discard: async () => {
          if (!detached) return
          await rm(quarantined, { recursive: true, force: false })
          detached = false
          await rm(quarantineRoot, { recursive: true, force: true }).catch(() => undefined)
        },
      },
    },
  }
}

/**
 * Plain same-origin request fence used when the Host exposes no connection service.
 * @param req - the incoming Node request.
 * @returns whether the request is a same-origin browser request.
 */
export function sameOriginRequest(req) {
  const host = req.headers.host
  return typeof host === 'string' && req.headers.origin === `http://${host}`
}

/**
 * Prefer the Host's own request fence (loopback authority, Host session cookie);
 * the Desktop app forwards dsh-app:// requests without an Origin header.
 * @param connection - the optional Host connection service.
 * @returns a predicate suitable for the destructive routes.
 */
export function hostRequestFence(connection) {
  if (typeof connection?.requestRejection !== 'function') return sameOriginRequest
  return req => connection.requestRejection(req) === undefined
}

/**
 * HTTP boundary for the destructive operation. The client must send a
 * same-origin JSON POST plus a confirmation-only header that links and HTML
 * forms cannot add.
 * @param root0 - the deletion implementation and the Host request fence.
 * @returns a route handler for the exact delete path.
 */
export function createDeleteRequestHandler({ deleteSession, isTrustedRequest = sameOriginRequest }) {
  return async (req, res) => {
    const contentType = req.headers['content-type']
    const confirmation = req.headers['x-dsh-session-delete-confirmation']
    const force = req.headers['x-dsh-session-delete-force'] === 'force'

    if (req.method !== 'POST') {
      sendJson(res, 405, failure('method-not-allowed', '只允许使用 POST 删除会话。'))
      return
    }
    if (!isTrustedRequest(req) || confirmation !== 'delete-session') {
      sendJson(res, 403, failure('forbidden', '删除请求未通过同源与确认校验。'))
      return
    }
    if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('application/json')) {
      sendJson(res, 415, failure('unsupported-media-type', '删除请求必须使用 JSON。'))
      return
    }

    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      const tooLarge = error instanceof Error && error.message === 'request-too-large'
      sendJson(
        res,
        tooLarge ? 413 : 400,
        failure(tooLarge ? 'request-too-large' : 'invalid-json', tooLarge ? '删除请求过大。' : '删除请求不是有效 JSON。'),
      )
      return
    }
    if (
      typeof body?.sessionId !== 'string'
      || body.sessionId.length === 0
      || body.sessionId.length > 512
      || body.sessionId.includes('\0')
    ) {
      sendJson(res, 400, failure('invalid-session-id', '会话 ID 无效。'))
      return
    }

    try {
      const result = await deleteSession(body.sessionId, { force })
      sendJson(res, result.ok ? 200 : 409, result)
    } catch {
      sendJson(res, 500, failure('internal', '删除过程中发生未预期错误，未确认删除成功。'))
    }
  }
}
