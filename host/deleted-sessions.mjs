// Retained deletions: a permanent delete moves the session directory into a
// trash folder under the profile instead of unlinking it, so the receipt's
// undo can put the conversation back. The trash is bounded: an entry lives
// until its undo window is closed explicitly, or an hour passes without one
// (a closed tab must not keep session data forever).

import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { inheritedEventCount, waitForCachedProjection } from './transfer.mjs'

/** Shape version of the trash sidecar. */
const STATE_VERSION = 1
/** How long an unclaimed retained session is kept before the next start drops it. */
export const RETAIN_LIFETIME_MS = 60 * 60 * 1000

/**
 * Absolute path of the trash directory for one profile.
 * @param profileDir - the profile directory.
 * @returns the trash root.
 */
export const retainedRoot = profileDir => path.join(profileDir, 'deleted-sessions')

/**
 * Absolute path of the sidecar that indexes the trash.
 * @param profileDir - the profile directory.
 * @returns the state file path.
 */
export const retainedStateFile = profileDir => path.join(profileDir, 'original-version-enhancements.deleted.json')

const emptyState = () => ({ version: STATE_VERSION, entries: {} })

const stringOf = value => (typeof value === 'string' ? value : '')

/**
 * Read the trash index, tolerating a missing or malformed file.
 *
 * Every entry must carry the paths an undo needs; an entry missing them can
 * never be restored (its directory would only be reachable through a guess), so
 * it is dropped here instead of turning into a `path.join` TypeError later.
 * @param profileDir - the profile directory.
 * @param warn - diagnostic sink.
 * @returns the mutable state object.
 */
export async function readRetainedState(profileDir, warn = () => undefined) {
  const file = retainedStateFile(profileDir)
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && parsed.entries !== null && typeof parsed.entries === 'object') {
      const entries = {}
      for (const [token, value] of Object.entries(parsed.entries)) {
        if (value === null || typeof value !== 'object') continue
        const sessionId = stringOf(value.sessionId)
        const projectDir = stringOf(value.projectDir)
        const directory = stringOf(value.directory)
        const name = stringOf(value.name) || sessionId
        if (sessionId.length === 0 || projectDir.length === 0 || directory.length === 0) {
          warn(`deleted-sessions: dropping unreadable entry ${token}`)
          continue
        }
        entries[token] = {
          token,
          sessionId,
          projectDir,
          name,
          directory,
          header: value.header !== null && typeof value.header === 'object' ? value.header : undefined,
          archived: value.archived === true,
          pinned: value.pinned === true,
          createdAt: typeof value.createdAt === 'number' ? value.createdAt : 0,
        }
      }
      return { version: STATE_VERSION, entries }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') warn(`deleted-sessions: could not read ${file}: ${String(error)}`)
  }
  return emptyState()
}

const writeRetainedState = async (profileDir, state) => {
  const file = retainedStateFile(profileDir)
  await mkdir(path.dirname(file), { recursive: true })
  // Atomic replace, for the same reason the automation sidecar uses one: a
  // half-written index would silently drop every pending undo.
  const temporary = `${file}.tmp`
  await writeFile(temporary, JSON.stringify(state), 'utf8')
  await rename(temporary, file)
}

/**
 * Move a directory, falling back to copy-then-remove across filesystems.
 * @param from - current location.
 * @param to - destination (must not exist).
 */
const moveDirectory = async (from, to) => {
  try {
    await rename(from, to)
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error
    await cp(from, to, { recursive: true, force: false })
    await rm(from, { recursive: true, force: true })
  }
}

const exists = async (target) => {
  try {
    await lstat(target)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

const failure = (code, message, extra) => ({
  ok: false,
  error: { code, message, ...(extra === undefined ? {} : extra) },
})

/**
 * Take one removed session directory into the trash and record what is needed
 * to put it back: the project directory, the directory name, its header, and
 * the registry flags an undo has to restore.
 *
 * The index is written after the move because the entry has to name the final
 * location. If that write fails the directory is moved back and the error is
 * propagated: reporting a retained deletion that no restart could ever find
 * would strand the conversation as an unreachable orphan.
 * @param options - profile directory, the removed directory, and its identity.
 * @returns the undo token.
 */
export async function retainDeletedSession({
  profileDir,
  sessionId,
  projectDir,
  name,
  sourceDirectory,
  header,
  archived = false,
  pinned = false,
  now = Date.now(),
  warn = () => undefined,
}) {
  const token = randomUUID()
  const root = retainedRoot(profileDir)
  await mkdir(root, { recursive: true })
  const directory = path.join(root, token)
  await moveDirectory(sourceDirectory, directory)
  const state = await readRetainedState(profileDir, warn)
  state.entries[token] = {
    token,
    sessionId,
    projectDir,
    name,
    directory,
    header,
    archived: archived === true,
    pinned: pinned === true,
    createdAt: now,
  }
  try {
    await writeRetainedState(profileDir, state)
  } catch (error) {
    try {
      await moveDirectory(directory, sourceDirectory)
      error.retained = 'rolled-back'
    } catch (restoreError) {
      // Both halves are now wrong: the index cannot name this directory, and the
      // original location is empty. Report where the data actually is so the
      // deletion is not confirmed as successful.
      error.retained = 'orphaned'
      error.trashDirectory = directory
      error.rollbackError = String(restoreError?.message ?? restoreError)
      warn(`deleted-sessions: could not index or roll back ${directory}: ${String(restoreError)}`)
    }
    throw error
  }
  return { token }
}

/**
 * Put a retained session back where it was deleted from, and file it again so
 * the sidebar lists it with its title instead of an untitled placeholder.
 * @param deps - profile directory, workspace registry, persistence, projection
 *   cache, and the lifecycle reservation hooks the delete path also uses.
 * @param request - the undo token.
 * @returns a tagged result understood by the delete dialog.
 */
export async function restoreRetainedSession(deps, { token }) {
  const {
    profileDir,
    workspaceRegistry,
    sessionPersistence,
    sessionProjectionCache,
    agentHandles,
    warn = () => undefined,
  } = deps
  const state = await readRetainedState(profileDir, warn)
  const entry = typeof token === 'string' ? state.entries[token] : undefined
  if (entry === undefined) {
    return failure('undo-expired', '撤销期限已过，该会话已彻底删除。')
  }

  // The same reservation a delete or move takes: an undo must not race another
  // operation on this id between its existence check and the rename.
  const release = typeof agentHandles?.reserve === 'function' ? agentHandles.reserve(entry.sessionId) : () => {}
  if (typeof agentHandles?.reserve === 'function' && release === undefined) {
    return failure('deletion-in-progress', '该会话正在进行删除、移动或还原，请稍后重试。')
  }

  try {
    const destination = path.join(entry.projectDir, entry.name ?? entry.sessionId)
    try {
      if (await exists(destination)) {
        return failure('undo-conflict', '原位置已经存在同名会话目录，未改动任何文件。')
      }
      await mkdir(entry.projectDir, { recursive: true })
      await moveDirectory(entry.directory, destination)
    } catch (error) {
      // The rename is the final arbiter: a destination that appeared after the
      // check fails here, which is a conflict rather than a broken restore.
      if (error?.code === 'EEXIST' || error?.code === 'ENOTEMPTY' || error?.code === 'EPERM') {
        return failure('undo-conflict', '原位置已经存在同名会话目录，未改动任何文件。')
      }
      if (error?.code === 'ENOENT') {
        // The retained directory vanished (a sweep or a manual clean-up). The
        // entry is spent either way.
        delete state.entries[token]
        await writeRetainedState(profileDir, state).catch(() => undefined)
        return failure('undo-expired', '撤销期限已过，该会话已彻底删除。')
      }
      return failure('undo-failed', `恢复会话存储失败：${String(error?.message ?? error)}`)
    }

    delete state.entries[token]
    await writeRetainedState(profileDir, state).catch(() => undefined)

    // Files are back; everything below only makes the Host see them again, and a
    // failure there is reported as a warning rather than undoing the restore.
    let warning
    try {
      if (typeof workspaceRegistry?.indexHeader === 'function') await workspaceRegistry.indexHeader(entry.header)
    } catch (error) {
      warning = String(error?.message ?? error)
    }
    let workspaceId = ''
    try {
      const workspace = typeof workspaceRegistry?.resolveByPath === 'function'
        ? await workspaceRegistry.resolveByPath(entry.header?.cwd)
        : undefined
      if (workspace !== undefined) {
        workspaceId = String(workspace.id ?? '')
        await workspace.attachSession(entry.sessionId)
        // Put the conversation back in the same lists it was deleted from.
        if (entry.archived === true && typeof workspaceRegistry?.archiveSession === 'function') {
          await workspaceRegistry.archiveSession(entry.sessionId)
        }
        if (entry.pinned === true && typeof workspaceRegistry?.pinSession === 'function') {
          await workspaceRegistry.pinSession(entry.sessionId)
        }
      }
    } catch (error) {
      warning = String(error?.message ?? error)
    }
    // Without a projection record the restored conversation would be listed as
    // untitled until it is opened; the same rule as a copied log applies here.
    try {
      const handle = await sessionPersistence?.open?.(entry.sessionId, 'read')
      if (handle !== undefined) {
        const header = handle.header
        const read = await handle.read().catch(() => undefined)
        try { await handle.close() } catch { /* the lease is already gone */ }
        const events = Array.isArray(read?.events) ? read.events : []
        const inherited = header?.isSeeded === true ? inheritedEventCount(events) : 0
        sessionProjectionCache?.coldSnapshot?.(header, inherited, events)
        await waitForCachedProjection(sessionProjectionCache, header)
      }
    } catch (error) {
      warning = String(error?.message ?? error)
    }
    return {
      ok: true,
      value: {
        sessionId: entry.sessionId,
        workspaceId,
        archived: entry.archived === true,
        pinned: entry.pinned === true,
        warning,
      },
    }
  } finally {
    release?.()
  }
}

/**
 * Drop one retained session for good (the undo window closed).
 * @param deps - profile directory and diagnostic sink.
 * @param request - the token to drop.
 * @returns a tagged result.
 */
export async function purgeRetainedSession(deps, { token }) {
  const { profileDir, warn = () => undefined } = deps
  const state = await readRetainedState(profileDir, warn)
  const entry = typeof token === 'string' ? state.entries[token] : undefined
  if (entry === undefined) return { ok: true, value: { purged: false } }
  delete state.entries[token]
  await writeRetainedState(profileDir, state).catch(() => undefined)
  await rm(entry.directory, { recursive: true, force: true }).catch(error => {
    warn(`deleted-sessions: could not remove ${entry.directory}: ${String(error)}`)
  })
  return { ok: true, value: { purged: true } }
}

/**
 * Drop retained sessions whose undo window was never claimed (a closed tab, a
 * crashed Host), plus directories the index does not know about — those are
 * leftovers of a failed retain and no undo can ever reach them. Called once on
 * plugin start so the trash cannot grow forever.
 * @param deps - profile directory, lifetime bound and clock.
 * @returns how many entries were dropped.
 */
export async function purgeStaleRetainedSessions(deps) {
  const { profileDir, maxAgeMs = RETAIN_LIFETIME_MS, now = Date.now(), warn = () => undefined } = deps
  const state = await readRetainedState(profileDir, warn)
  let dropped = 0
  for (const [token, entry] of Object.entries(state.entries)) {
    if (now - entry.createdAt < maxAgeMs) continue
    delete state.entries[token]
    await rm(entry.directory, { recursive: true, force: true }).catch(() => undefined)
    dropped += 1
  }
  if (dropped > 0) await writeRetainedState(profileDir, state).catch(() => undefined)

  // A directory the index never recorded can only be the residue of a retain
  // whose index write failed; it is unclaimable, so it is dropped once it is old
  // enough that no in-flight retain can own it.
  let orphaned = 0
  try {
    for (const item of await readdir(retainedRoot(profileDir), { withFileTypes: true })) {
      if (!item.isDirectory() || Object.hasOwn(state.entries, item.name)) continue
      const directory = path.join(retainedRoot(profileDir), item.name)
      try {
        const info = await lstat(directory)
        if (now - info.mtimeMs < maxAgeMs) continue
      } catch { continue }
      await rm(directory, { recursive: true, force: true }).catch(() => undefined)
      orphaned += 1
    }
  } catch { /* an absent trash root needs no sweep */ }
  return dropped + orphaned
}
