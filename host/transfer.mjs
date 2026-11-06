// Session transfer: copy — or copy then remove the original — one Session into
// another Workspace.
//
// A Session's Workspace membership is its immutable stored `cwd`, validated by
// the Workspace registry, so a live Session can never be re-filed by rewriting
// accounting. The transfer therefore materialises an independent Session in the
// target directory whose event log is a faithful copy of the source, and then
// files that new Session into the target Workspace.

import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { deleteSessionSafely } from './delete-session.mjs'

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
 * Lineage fields are dropped so the copy is not a branch of its source.
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
    isSeeded: false,
  }
  if (typeof header.agentPreset === 'string') next.agentPreset = header.agentPreset
  return next
}

/**
 * Seed events for the copy: the whole source log plus the inherited-cut marker
 * the Session store expects of a branch, matching a fork's shape.
 * @param events - the source events in sequence order.
 * @returns the seed events.
 */
const forkSeed = (events) => {
  const last = events[events.length - 1]
  return [
    ...events,
    { type: 'session/end-seed', seq: events.length, time: last.time, data: { inherited: true } },
  ]
}

/**
 * Write the copy's log. The Agent lifecycle is preferred: it persists the seed,
 * announces the Session so every client learns about it, and checkpoints
 * projections. Without an Agent factory the log is written through persistence
 * and its projection checkpoint warmed directly.
 * @param deps - agent, model, persistence, and projection services.
 * @param meta - the copy's header.
 * @param events - the source events.
 * @returns whether the copy now exists.
 */
const materializeCopy = async (deps, meta, events) => {
  const { agents, sessionPersistence, sessionProjectionCache } = deps
  if (typeof agents?.create === 'function') {
    let selection
    try {
      selection = deps.agentDefaultModel?.currentSelection?.()
    } catch { /* an unconfigured default model leaves the route to the factory */ }
    const create = (preset) => agents.create({
      sessionId: meta.id,
      seed: forkSeed(events),
      inheritedEventCount: events.length,
      meta: {
        cwd: meta.cwd,
        isSeeded: true,
        ...(preset === undefined ? {} : { agentPreset: preset }),
      },
      ...(selection === undefined ? {} : { agentOptions: { provider: selection.provider, model: selection.model } }),
    })
    try {
      await create(meta.agentPreset)
      return true
    } catch (error) {
      // A preset that no longer mounts must not cost the user the copy.
      if (meta.agentPreset === undefined) throw error
      await create(undefined)
      return true
    }
  }

  const handle = await sessionPersistence.create(meta)
  try {
    await handle.append(events)
    await handle.flush()
  } finally {
    try { await handle.close() } catch { /* flush already settled the log */ }
  }
  // The sidebar lists a session from its projection cache; a freshly written
  // log has none, so warm it here or the copy stays invisible until opened.
  try {
    sessionProjectionCache?.coldSnapshot?.(meta, 0, events)
  } catch { /* the copy is filed either way; the next cold read fills it */ }
  return true
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
 * Copy one Session into another Workspace, and for `move` also remove the
 * original once the copy is filed.
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

  const copyId = `session-${randomUUID()}`
  const copyMeta = copyHeader(header, copyId, target.path)
  let created = false
  try {
    created = await materializeCopy(deps, copyMeta, events)
  } catch (error) {
    if (created) await removeCopy(deps, copyId)
    return failure('copy-failed', `复制会话失败：${String(error?.message ?? error)}`)
  }
  if (!created) return failure('copy-failed', '无法创建会话副本。')

  try {
    await target.attachSession(copyId)
  } catch (error) {
    await removeCopy(deps, copyId)
    return failure('copy-failed', `复制出的会话无法归入目标工作区：${String(error?.message ?? error)}`)
  }

  if (mode === 'copy') return { ok: true, value: { sessionId: copyId, workspaceId: target.id, mode } }

  const removal = await deleteSessionSafely({
    sessions: deps.sessions,
    agents: deps.agents,
    agentHandles: deps.agentHandles,
    sessionPersistence,
  }, { sessionRoot: deps.sessionRoot, sessionId, force: false })

  if (!removal.ok) {
    return failure(
      'move-source-kept',
      `已复制到目标工作区，但原会话未能删除：${removal.error.message}`,
      { copyId },
    )
  }
  try { await workspaceRegistry.unarchiveSession(sessionId) } catch { /* the copy already exists */ }
  return { ok: true, value: { sessionId: copyId, workspaceId: target.id, mode } }
}

/**
 * Drop a copy whose filing failed, so a failed transfer leaves no orphan log.
 * @param deps - the deletion dependencies.
 * @param sessionId - the copy to remove.
 */
const removeCopy = async (deps, sessionId) => {
  try {
    await deleteSessionSafely({
      sessions: deps.sessions,
      agents: deps.agents,
      agentHandles: deps.agentHandles,
      sessionPersistence: deps.sessionPersistence,
    }, { sessionRoot: deps.sessionRoot, sessionId, force: true })
  } catch { /* the caller still reports the original failure */ }
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
