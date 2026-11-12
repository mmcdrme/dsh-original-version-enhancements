// Session transfer: copy — or copy then remove the original — one Session into
// another Workspace.
//
// A Session's Workspace membership is its immutable stored `cwd`, validated by
// the Workspace registry, so a live Session can never be re-filed by rewriting
// accounting. The transfer therefore materialises an independent Session in the
// target directory whose event log is a faithful copy of the source, and then
// files that new Session into the target Workspace.

import { randomUUID } from 'node:crypto'
import { lstat, mkdtemp, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { deleteSessionWithoutReservation, quarantineSessionForMove } from './delete-session.mjs'

const MAX_REQUEST_BYTES = 8 * 1024
/** Request header that must accompany every transfer; a link or form cannot set it. */
export const TRANSFER_CONFIRMATION = 'transfer-session'

const failure = (code, message, extra) => ({
  ok: false,
  error: { code, message, ...(extra === undefined ? {} : extra) },
})

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

/**
 * Whether a log ends inside an open turn.
 * @param events - the stored events in sequence order.
 * @returns true when the tail turn never closed.
 */
const hasOpenTurn = (events) => {
  let open = false
  for (const event of events) {
    if (event?.type === 'turn/start') open = true
    else if (event?.type === 'turn/end') open = false
  }
  return open
}

/**
 * Header for the copied Session: a fresh identity in the target directory.
 * Lineage fields are dropped so the copy is not a branch of its source, but the
 * seed flag MUST follow the copied log: a log carrying the `session/end-seed`
 * marker is only readable as a seeded Session.
 * @param header - the source Session header.
 * @param id - the new Session id.
 * @param cwd - the target Workspace path.
 * @returns a header accepted by the persistence backend.
 */
const copyHeader = (header, id, cwd) => {
  const next = {
    version: header.version,
    id,
    createdAt: Date.now(),
    cwd,
    isSeeded: header.isSeeded === true,
  }
  if (typeof header.agentPreset === 'string') next.agentPreset = header.agentPreset
  return next
}

/**
 * Number of events a seeded log inherited before its own first event. The
 * `session/end-seed` marker sits exactly at that cut, so its index into the log
 * is the inherited prefix length the persistence header must record.
 * @param events - the copied events in sequence order.
 * @returns the inherited prefix length, zero for an unseeded log.
 */
const inheritedCount = (events) => {
  const marker = events.findIndex(event => event?.type === 'session/end-seed')
  if (marker < 0) return 0
  return events[marker].seq ?? marker
}

/**
 * Write the copy's log through session persistence. The log is a complete,
 * self-contained session, and its projection checkpoint is warmed directly so
 * the listing can show a title without opening the conversation first. An Agent
 * is deliberately NOT created: the lifecycle handle would be torn down with
 * this plugin, and the catalog drops a disposed session until the Host
 * re-indexes, so the copy would vanish from the sidebar after a reload.
 * @param deps - persistence and projection services.
 * @param meta - the copy's header.
 * @param events - the source events.
 * @returns whether the copy now exists.
 */
const materializeCopy = async (deps, meta, events) => {
  const { sessionPersistence, sessionProjectionCache } = deps
  const inherited = inheritedCount(events)
  // The persistence header of a seeded log must carry its inherited prefix
  // length; without it the backend refuses to materialize the copy at all.
  const handle = await sessionPersistence.create(meta, meta.isSeeded ? { inheritedEventCount: inherited } : undefined)
  try {
    await handle.append(events)
    await handle.flush()
    // Never file a copy that has no durable log: a half-written session shows up
    // in the sidebar and then refuses to open its history. Verify while the
    // failure is still recoverable rather than leaving the shell behind.
    await verifyMaterialized(sessionPersistence, meta.id, events.length)
  } catch (error) {
    // `create` has already published the header, so append/flush/verify failing
    // (full disk, EIO, short log) leaves a session the backend can list. The
    // old code left exactly that behind: a second log for one id after a failed
    // move. Remove what this call created before reporting the failure.
    try { await handle.close() } catch { /* the leased handle is already gone */ }
    const removed = await removeCopyWhileReserved(deps, meta.id)
    const problem = error instanceof Error ? error : new Error(String(error))
    problem.copyCleanup = removed ? 'done' : 'failed'
    throw problem
  } finally {
    try { await handle.close() } catch { /* flush already settled the log */ }
  }
  try {
    sessionProjectionCache?.coldSnapshot?.(meta, inherited, events)
  } catch { /* the copy is filed either way; the next cold read fills it */ }
  return true
}

/**
 * Confirm the copy reached durable storage with at least its whole log.
 * @param persistence - the JSONL backend.
 * @param sessionId - the copy's identity.
 * @param expectedEvents - how many events the copy must carry.
 * @throws when the session is unknown to the backend or its log is empty/short.
 */
const verifyMaterialized = async (persistence, sessionId, expectedEvents) => {
  const snapshot = await persistence.stat(sessionId).catch(() => undefined)
  if (snapshot === undefined) throw new Error('宿主没有落盘复制出的会话')
  if (typeof snapshot.eventCount === 'number' && snapshot.eventCount < expectedEvents) {
    throw new Error(`复制出的会话日志不完整（${snapshot.eventCount}/${expectedEvents} 条事件）`)
  }
  if (typeof snapshot.sizeBytes === 'number' && snapshot.sizeBytes === 0) {
    throw new Error('复制出的会话日志为空')
  }
  const location = snapshot.location
  if (location?.kind === 'jsonl' && typeof location.path === 'string') {
    const info = await stat(location.path).catch(() => undefined)
    if (info === undefined || !info.isFile() || info.size === 0) throw new Error('复制出的会话日志没有落盘')
  }
}

/**
 * Canonical path comparison that tolerates an already-canonical target.
 * @param path - the path to canonicalize.
 * @returns the canonical path, or the input when it cannot be resolved.
 */
const canonicalOrSelf = async (path) => {
  try {
    return await realpath(path)
  } catch {
    return path
  }
}

/**
 * Resolve a workspace by id, falling back to its directory path: the browser
 * snapshot may only expose one of the two spellings.
 * @param registry - the workspace registry service.
 * @param id - workspace id or directory path.
 * @returns the workspace entity, or undefined.
 */
const resolveWorkspace = async (registry, id) => {
  const direct = registry.get(id)
  if (direct !== undefined) return direct
  if (typeof registry.resolveByPath !== 'function') return undefined
  try {
    return await registry.resolveByPath(id)
  } catch {
    return undefined
  }
}

/**
 * Take the deletion reservation for one session id when the Host tracks
 * lifecycles. Transfer and permanent deletion share this set, so a move and a
 * delete of the same id can no longer rename each other's directory.
 * @param deps - dependencies, optionally carrying the lifecycle hooks.
 * @param sessionId - the id the operation is about to rewrite or file.
 * @returns the release function, a no-op when tracking is unavailable, or
 *   undefined when another operation already owns the id.
 */
const reserveSession = (deps, sessionId) => {
  const reserve = deps.agentHandles?.reserve
  if (typeof reserve !== 'function') return () => {}
  return reserve.call(deps.agentHandles, sessionId)
}

/**
 * Copy one Session into another Workspace, or move it there while keeping its
 * session identity.
 * @param deps - Workspace registry, session persistence, and the deletion dependencies.
 * @param request - source Session, target Workspace, and `copy` or `move`.
 * @returns a tagged result understood by the session menu.
 */
export async function transferSession(deps, request) {
  const { workspaceRegistry, sessionPersistence } = deps
  const { sessionId, workspaceId } = request
  const mode = request.mode === 'move' ? 'move' : 'copy'

  if (typeof workspaceRegistry?.get !== 'function' || typeof sessionPersistence?.open !== 'function') {
    return failure('unsupported', '当前宿主不支持在插件内转移会话。')
  }

  // An archived session is hidden from the workspace list on purpose, so the
  // menu never offers these actions for one. Enforce the same rule here: a
  // client whose archive set has not caught up (or an archive that landed
  // between opening the menu and clicking) must not silently re-file it.
  const archivedIds = Array.isArray(workspaceRegistry.archivedSessionIds) ? workspaceRegistry.archivedSessionIds : []
  if (archivedIds.includes(sessionId)) {
    return failure('session-archived', '该会话已归档，请先取消归档后再移动或复制。')
  }

  const target = await resolveWorkspace(workspaceRegistry, workspaceId)
  if (target === undefined) return failure('workspace-not-found', '目标工作区不存在。')

  let status
  try {
    status = await target.status()
  } catch {
    status = 'missing-dir'
  }
  if (status !== 'ok') return failure('workspace-missing', '目标工作区的目录不存在，无法放入会话。')

  let source
  try {
    source = await sessionPersistence.open(sessionId, 'read')
  } catch {
    return failure('session-not-found', '会话不存在或已经删除。')
  }

  let header
  let events
  try {
    header = source.header
    const read = await source.read()
    events = Array.isArray(read?.events) ? read.events : []
  } catch {
    return failure('session-unreadable', '无法读取该会话的记录，未做任何改动。')
  } finally {
    try { await source.close() } catch { /* the read lease is already gone */ }
  }

  if (events.length === 0) return failure('session-empty', '空会话没有可复制的对话内容。')
  if (hasOpenTurn(events)) return failure('session-running', '会话还有未结束的回合，请等它结束后再操作。')

  const sourcePath = typeof header?.cwd === 'string' ? await canonicalOrSelf(header.cwd) : ''
  if (sourcePath.length > 0 && sourcePath === target.path) {
    return failure('same-workspace', '该会话已经在这个工作区中。')
  }

  if (mode === 'move') {
    // The move rewrites the session under its own id, so it must own the same
    // reservation a permanent delete takes; otherwise the two can rename and
    // delete each other's directories.
    const reservation = reserveSession(deps, sessionId)
    if (reservation === undefined) {
      return failure('deletion-in-progress', '该会话正在删除或移动中，请等待当前操作完成。')
    }
    try {
      return await moveSession(deps, { sessionId, header, target })
    } finally {
      reservation()
    }
  }

  const copyId = `session-${randomUUID()}`
  const copyMeta = copyHeader(header, copyId, target.path)
  try {
    await materializeCopy(deps, copyMeta, events)
  } catch (error) {
    const suffix = error?.copyCleanup === 'failed' ? '；临时副本未能自动清理，请重启后再清理。' : ''
    return failure('copy-failed', `复制会话失败：${String(error?.message ?? error)}${suffix}`)
  }

  // Reserve the fresh id before filing it: a concurrent permanent delete must
  // not find the copy between materialising and attaching it.
  const reservation = reserveSession(deps, copyId)
  if (reservation === undefined) {
    await removeCopyWhileReserved(deps, copyId)
    return failure('deletion-in-progress', '复制出的会话正在被另一个操作使用，请稍后重试。')
  }
  try {
    await target.attachSession(copyId)
  } catch (error) {
    const removed = await removeCopyWhileReserved(deps, copyId)
    const suffix = removed ? '' : '；临时副本未能自动清理，请重启后再清理。'
    return failure('copy-failed', `复制出的会话无法归入目标工作区：${String(error?.message ?? error)}${suffix}`)
  } finally {
    reservation()
  }

  return { ok: true, value: { sessionId: copyId, workspaceId: target.id, mode } }
}

/**
 * Header for a moved Session: the SAME identity (id, creation time, lineage),
 * with only the workspace-bearing `cwd` replaced. Keeping the id is what makes
 * a move invisible to everything that names the conversation — links, an open
 * view, automation bindings — instead of turning it into a different session.
 * @param header - the source Session header.
 * @param cwd - the target Workspace path.
 * @returns a header the persistence backend accepts under the same session id.
 */
const moveHeader = (header, cwd) => ({ ...header, cwd })

/**
 * Refresh the Workspace registry's header index for one moved session. The
 * registry caches each header and its canonical cwd at startup, so without this
 * the target workspace would still validate the old cwd and refuse to file it.
 * @param registry - the Workspace registry service.
 * @param header - the moved session's new header.
 * @returns whether the Host accepted the refreshed identity.
 */
const reindexMovedSession = async (registry, header) => {
  if (registry === undefined || typeof registry.indexHeader !== 'function') return false
  try {
    await registry.indexHeader(header)
    return true
  } catch {
    return false
  }
}

/**
 * Move one Session into another Workspace while preserving its session id. The
 * source log is quarantined out of the persistence root first, so the recreated
 * log under the target directory can carry the same id without presenting a
 * duplicate id to the backend; every event and the session identity are carried
 * over unchanged.
 * @param deps - Workspace registry, persistence, projection cache, lifecycle hooks.
 * @param request - the session, its source header, and the target workspace.
 * @returns a tagged result understood by the session menu.
 */
const moveSession = async (deps, { sessionId, header, target }) => {
  const { workspaceRegistry } = deps
  if (typeof workspaceRegistry.indexHeader !== 'function') {
    return failure('move-unsupported', '当前宿主不允许刷新会话的工作区归属，未做任何改动。')
  }
  const sourcePath = typeof header?.cwd === 'string' ? await canonicalOrSelf(header.cwd) : ''
  const sourceWorkspace = sourcePath.length > 0
    ? await resolveWorkspace(workspaceRegistry, sourcePath)
    : undefined

  const prepared = await quarantineSessionForMove(deps, {
    sessionRoot: deps.sessionRoot,
    sessionId,
    expectedHeader: header,
  })
  if (prepared.ok !== true) return prepared

  const { header: liveHeader, events, quarantine } = prepared.value
  if (hasOpenTurn(events)) {
    // The log changed between the preflight read and the write lease (an
    // auto-wake started a turn), so put everything back instead of moving a
    // half-finished conversation.
    try {
      await quarantine.restore()
    } catch {
      return failure('move-partial', `原会话目录未能自动还原（暂存于 ${quarantine.directory}）。`)
    }
    return failure('session-running', '会话还有未结束的回合，请等它结束后再操作。')
  }
  const movedMeta = moveHeader(liveHeader, target.path)
  let materialized = false
  let attached = false
  try {
    await materializeCopy(deps, movedMeta, events)
    materialized = true
    if (!await reindexMovedSession(workspaceRegistry, movedMeta)) {
      throw new Error('宿主没有接受更新后的会话归属信息')
    }
    await target.attachSession(sessionId)
    attached = true
  } catch (error) {
    // materializeCopy removed its own half-written log when it could. When it
    // could not, the new log and the quarantined original both exist, so the
    // original must stay quarantined and the caller has to report the residual path.
    if (error?.copyCleanup === 'failed') {
      return failure(
        'move-partial',
        `移动失败，且临时会话未能清理；原会话目录暂存于 ${quarantine.directory}，请重启后再清理。`,
      )
    }
    // Only a copy that actually reached persistence needs removing here.
    const removed = materialized ? await removeCopyWhileReserved(deps, sessionId) : true
    if (!removed) {
      return failure(
        'move-partial',
        `移动失败，且临时会话未能清理；原会话目录暂存于 ${quarantine.directory}，请重启后再清理。`,
      )
    }
    try {
      await quarantine.restore()
    } catch {
      return failure(
        'move-partial',
        `移动失败，且原会话目录未能自动还原（暂存于 ${quarantine.directory}）。`,
      )
    }
    // `indexHeader` overwrites the registry's cached header and canonical cwd in
    // place, so putting the log back is not enough: without this the registry
    // still points the session at the target workspace and filters it out of the
    // source one, making the conversation disappear from the sidebar until the
    // next restart rescans the headers.
    if (attached) {
      try { await target.detachSession?.(sessionId) } catch { /* nothing to undo */ }
    }
    await reindexMovedSession(workspaceRegistry, header)
    return failure('move-failed', `移动会话失败：${String(error?.message ?? error)}`)
  }

  // The session now belongs to the target: drop the source accounting so the old
  // workspace cannot keep listing it, then remove the quarantined original.
  try { await sourceWorkspace?.detachSession?.(sessionId) } catch { /* startup reconciliation removes it */ }
  try { await workspaceRegistry.unarchiveSession(sessionId) } catch { /* not archived */ }
  if (typeof workspaceRegistry.unpinSession === 'function') {
    try { await workspaceRegistry.unpinSession(sessionId) } catch { /* not pinned */ }
  }
  let warning
  try {
    await quarantine.discard()
  } catch (error) {
    warning = String(error?.message ?? error)
  }
  const sourceWorkspaceId = sourceWorkspace === undefined ? '' : String(sourceWorkspace.id ?? '')
  return {
    ok: true,
    value: {
      sessionId,
      workspaceId: target.id,
      mode: 'move',
      // Enough for the client's toast to offer Undo even when the conversation
      // was not filed under any workspace: the notification names both the
      // workspace id and the recorded directory.
      source: { workspaceId: sourceWorkspaceId, cwd: sourcePath },
      ...(warning === undefined ? {} : { warning }),
    },
  }
}

/**
 * Drop a copy whose filing failed, so a failed transfer leaves no orphan log.
 * For a caller that already holds this session's reservation (the move path
 * owns the source id, the copy path owns the new id), so the removal itself
 * does not try to reserve it again.
 * @param deps - the deletion dependencies.
 * @param sessionId - the copy to remove.
 * @returns whether the copy is gone.
 */
const removeCopyWhileReserved = async (deps, sessionId) => {
  try {
    const result = await deleteSessionWithoutReservation({
      ...deps,
      sessionPersistence: deps.sessionPersistence,
    }, { sessionRoot: deps.sessionRoot, sessionId, force: true, purge: false })
    if (result.ok === true) return true
  } catch { /* fall through to the storage scan */ }
  // A backend that has not indexed the fresh header yet cannot locate the log
  // through `list`/`stat`; the directory is still under the persistence root.
  return removeUnindexedMaterialization(deps, sessionId)
}

/**
 * Last-resort removal for a copy this call just created whose backend cannot
 * see it yet. Under the persistence root the id can only be this call's own
 * log: a move has already quarantined the original outside the root, and a
 * copy's id is a fresh uuid.
 * @param deps - transfer dependencies (only `sessionRoot` is used).
 * @param sessionId - the id whose materialization should be removed.
 * @returns whether a directory with that id was found and removed.
 */
const removeUnindexedMaterialization = async (deps, sessionId) => {
  let root
  try {
    root = await realpath(deps.sessionRoot)
  } catch {
    return false
  }
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch {
    return false
  }
  let removed = false
  for (const project of projects) {
    if (!project.isDirectory() || project.isSymbolicLink()) continue
    const directory = join(root, project.name, sessionId)
    let info
    try {
      info = await lstat(directory, { bigint: true })
    } catch {
      continue
    }
    if (!info.isDirectory() || info.isSymbolicLink()) continue
    const entries = await readdir(directory).catch(() => [])
    if (!entries.some(name => /^session(?:\.v[1-9]\d*)?\.jsonl(?:\.zstd)?$/u.test(name))) continue
    let quarantineRoot
    try {
      quarantineRoot = await mkdtemp(join(dirname(root), '.ove-transfer-rollback-'))
      const quarantined = join(quarantineRoot, `${project.name}-${sessionId}`)
      await rename(directory, quarantined)
      const after = await lstat(quarantined, { bigint: true })
      if (!after.isDirectory() || after.isSymbolicLink()) {
        await rename(quarantined, directory)
        await rm(quarantineRoot, { recursive: true, force: true })
        return false
      }
      await rm(quarantined, { recursive: true, force: false })
      await rm(quarantineRoot, { recursive: true, force: true })
      removed = true
    } catch {
      if (quarantineRoot !== undefined) await rm(quarantineRoot, { recursive: true, force: true }).catch(() => undefined)
      return false
    }
  }
  return removed
}

/**
 * HTTP boundary for the transfer: same-origin JSON POST plus the confirmation
 * header, mirroring the permanent-deletion route.
 * @param root0 - the transfer implementation and the Host request fence.
 * @returns a route handler for the exact transfer path.
 */
export function createTransferRequestHandler({ transfer, isTrustedRequest }) {
  return async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, failure('method-not-allowed', '只允许使用 POST 转移会话。'))
      return
    }
    if (!isTrustedRequest(req) || req.headers['x-dsh-session-transfer-confirmation'] !== TRANSFER_CONFIRMATION) {
      sendJson(res, 403, failure('forbidden', '转移请求未通过同源与确认校验。'))
      return
    }
    const contentType = req.headers['content-type']
    if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('application/json')) {
      sendJson(res, 415, failure('unsupported-media-type', '转移请求必须使用 JSON。'))
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
        failure(tooLarge ? 'request-too-large' : 'invalid-json', tooLarge ? '转移请求过大。' : '转移请求不是有效 JSON。'),
      )
      return
    }

    const invalid = (value) => typeof value !== 'string' || value.length === 0 || value.length > 512 || value.includes('\0')
    if (invalid(body?.sessionId) || invalid(body?.workspaceId)) {
      sendJson(res, 400, failure('invalid-request', '会话或工作区标识无效。'))
      return
    }

    try {
      const result = await transfer({
        sessionId: body.sessionId,
        workspaceId: body.workspaceId,
        mode: body.mode === 'move' ? 'move' : 'copy',
      })
      sendJson(res, result.ok ? 200 : 409, result)
    } catch {
      sendJson(res, 500, failure('internal', '转移过程中发生未预期错误，未确认操作结果。'))
    }
  }
}
