// 原版功能增强 — Automation task enhancements.
// The shipped Automation tasks page (ui-schedule 0.2.x) already owns creation,
// filters, search, editing and records. This module adds the three capabilities
// that page does not have, on top of the current Host Schedule service:
//   1. bulk deletion of selected tasks,
//   2. binding one task's rule to several conversations (one task per Session),
//   3. an auto-clean flag that removes a finished one-shot task after delivery.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const MAX_REQUEST_BYTES = 32 * 1024
const STATE_VERSION = 1

const failure = (code, message) => ({ ok: false, error: { code, message } })

const sendJson = (res, status, payload) => {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(payload))
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

const sameOriginRequest = req => typeof req.headers.host === 'string'
  && req.headers.origin === `http://${req.headers.host}`

/**
 * The profile directory that owns this Host's local sidecar files.
 * @returns an absolute directory path.
 */
export function profileDirectory() {
  if (process.env.DSH_PROFILE_DIR) return process.env.DSH_PROFILE_DIR
  return path.join(os.homedir(), '.dsh', 'profiles', process.env.DSH_PROFILE || 'desktop')
}

/**
 * Read the auto-clean sidecar, tolerating a missing or malformed file.
 * @param file - absolute sidecar path.
 * @param warn - diagnostic sink.
 * @returns the mutable state object.
 */
export function readAutomationState(file, warn) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && parsed.autoClean !== null && typeof parsed.autoClean === 'object') {
      const autoClean = {}
      for (const [id, value] of Object.entries(parsed.autoClean)) {
        if (typeof id === 'string' && id.length > 0) autoClean[id] = value === true
      }
      return { version: STATE_VERSION, autoClean }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') warn(`automation: could not read ${file}: ${String(error)}`)
  }
  return { version: STATE_VERSION, autoClean: {} }
}

/**
 * Persist the auto-clean sidecar; a failure is reported, never thrown.
 * @param file - absolute sidecar path.
 * @param state - the state object to store.
 * @param warn - diagnostic sink.
 */
export function writeAutomationState(file, state, warn) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(state), 'utf8')
  } catch (error) {
    warn(`automation: could not write ${file}: ${String(error)}`)
  }
}

/**
 * Rebuild the Host timing request from a stored task record so a clone keeps
 * the same rule instead of re-deriving it from a localized description.
 * @param record - one ScheduleCatalogEntry.
 * @returns a ScheduleTiming request, or undefined for an unsupported record.
 */
export function timingOf(record) {
  if (record === null || typeof record !== 'object') return undefined
  switch (record.kind) {
    case 'after':
      return typeof record.afterSeconds === 'number'
        ? { kind: 'after', after_seconds: record.afterSeconds }
        : undefined
    case 'at':
      return typeof record.scheduledAt === 'string'
        ? { kind: 'at', at: record.scheduledAt }
        : undefined
    case 'every':
      return typeof record.everySeconds === 'number'
        ? { kind: 'every', every_seconds: record.everySeconds }
        : undefined
    case 'daily':
      return typeof record.time === 'string' && typeof record.timeZone === 'string'
        ? { kind: 'daily', daily: { time: record.time, time_zone: record.timeZone } }
        : undefined
    case 'weekly':
      return typeof record.time === 'string'
        && typeof record.timeZone === 'string'
        && Array.isArray(record.weekdays)
        ? { kind: 'weekly', weekly: { time: record.time, time_zone: record.timeZone, weekdays: [...record.weekdays] } }
        : undefined
    case 'cron':
      return typeof record.expression === 'string' && typeof record.timeZone === 'string'
        ? { kind: 'cron', cron: { expression: record.expression, time_zone: record.timeZone } }
        : undefined
    case 'rrule':
      return typeof record.rrule === 'string' ? { kind: 'rrule', rrule: record.rrule } : undefined
    default:
      return undefined
  }
}

/**
 * Where a task delivers, in a form the Client can link.
 * @param record - one ScheduleCatalogEntry.
 * @returns a compact target description.
 */
export function targetOf(record) {
  const target = record?.target
  if (target?.kind === 'session') {
    return { kind: 'session', sessionId: target.sessionId, cwd: undefined }
  }
  const create = target?.create ?? {}
  return {
    kind: target?.kind === 'new_once' ? 'new_once' : 'new',
    sessionId: typeof target?.sessionId === 'string' ? target.sessionId : undefined,
    cwd: typeof create.cwd === 'string' ? create.cwd : undefined,
  }
}

/**
 * One catalog entry reduced to what the enhancement panel renders.
 * @param record - one ScheduleCatalogEntry.
 * @returns the compact row payload.
 */
const rowOf = record => ({
  id: record.id,
  title: record.title,
  prompt: record.prompt,
  kind: record.kind,
  status: record.status,
  scheduledAt: record.scheduledAt,
  updatedAt: record.updatedAt ?? record.createdAt,
  lastDelivery: record.lastDelivery === undefined ? null : record.lastDelivery,
  executionActive: record.executionActive === true,
  target: targetOf(record),
  involvedSessionIds: Array.isArray(record.involvedSessionIds) ? [...record.involvedSessionIds] : [],
})

/**
 * Apply or clear one task's auto-clean choice.
 * @param deps - service access and sidecar state.
 * @param request - `{id, autoClean}`.
 * @returns the applied state or a miss.
 */
async function setAutoClean(deps, request) {
  const { service, state, save } = deps
  const tasks = await service.catalog()
  const task = tasks.find(candidate => candidate.id === request.id)
  if (task === undefined) {
    delete state.autoClean[request.id]
    save()
    return { id: request.id, updated: false, code: 'schedule_not_found' }
  }
  if (request.autoClean === true) state.autoClean[request.id] = true
  else delete state.autoClean[request.id]
  save()
  return { id: request.id, updated: true, autoClean: request.autoClean === true }
}

/**
 * Delete one task by identity through the Schedule edit surface.
 * @param service - the Host Schedule service.
 * @param id - task identity.
 * @returns the Host result.
 */
async function deleteTask(service, id) {
  const result = await service.edit({ id, action: 'delete' })
  return result?.deleted === true ? { id, deleted: true } : { id, deleted: false, code: result?.code ?? 'schedule_not_found' }
}

/**
 * Remove the auto-clean flag of every task that no longer needs it. A one-shot
 * task keeps its delivery receipt, so a stored `lastDelivery` on an ended task
 * is the signal that this task already delivered and may be cleaned up.
 * @param deps - service access and sidecar state, plus a log sink.
 * @returns the number of removed tasks.
 */
export async function reconcileAutoClean({ service, state, save, warn = () => {} }) {
  const ids = Object.keys(state.autoClean)
  if (ids.length === 0) return 0
  let removed = 0
  let changed = false
  let tasks
  try {
    tasks = await service.catalog()
  } catch (error) {
    warn(`automation: auto-clean catalog failed: ${String(error)}`)
    return 0
  }
  const byId = new Map(tasks.map(task => [task.id, task]))
  for (const id of ids) {
    const task = byId.get(id)
    if (task === undefined) {
      delete state.autoClean[id]
      changed = true
      continue
    }
    if (task.status !== 'ended' || task.lastDelivery === undefined) continue
    try {
      const result = await deleteTask(service, id)
      if (result.deleted) removed += 1
      delete state.autoClean[id]
      changed = true
    } catch (error) {
      warn(`automation: auto-clean delete failed for ${id}: ${String(error)}`)
    }
  }
  if (changed) save()
  return removed
}

/**
 * Create one copy of a task for each requested conversation.
 * @param deps - service access.
 * @param request - `{id, sessionIds}`.
 * @returns created tasks and per-Session failures.
 */
async function bindToSessions({ service, state, save }, request) {
  const tasks = await service.catalog()
  const source = tasks.find(task => task.id === request.id)
  if (source === undefined) {
    return { ok: false, error: { code: 'schedule_not_found', message: '任务不存在或已删除。' } }
  }
  const timing = timingOf(source)
  if (timing === undefined) {
    return { ok: false, error: { code: 'timing-unsupported', message: '该任务的重复规则无法复制到其他会话。' } }
  }
  const current = source.target?.kind === 'session' ? source.target.sessionId : undefined
  const wanted = []
  for (const sessionId of request.sessionIds) {
    if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId === current) continue
    if (!wanted.includes(sessionId)) wanted.push(sessionId)
  }
  if (wanted.length === 0) {
    return { ok: false, error: { code: 'no-sessions', message: '请至少选择一个其他会话。' } }
  }

  const created = []
  const failed = []
  for (const sessionId of wanted) {
    try {
      const record = await service.create({
        title: source.title,
        prompt: source.prompt,
        timing,
        target: { kind: 'session', sessionId },
      })
      created.push({ id: record.id, sessionId })
      if (state.autoClean[source.id] === true) state.autoClean[record.id] = true
    } catch (error) {
      failed.push({ sessionId, message: error instanceof Error ? error.message : String(error) })
    }
  }
  if (created.length > 0) save()
  return { ok: true, value: { created, failed } }
}

/**
 * Bind every automation route to one Service and one sidecar state.
 * @param options - service accessor, sidecar state, request fence, and log sink.
 * @returns the HTTP boundary plus the reconciler used by the Host event hook.
 */
export function createAutomationSurface(options) {
  const {
    service,
    state,
    save,
    isTrustedRequest = sameOriginRequest,
    warn = () => {},
  } = options
  const deps = { service, state, save, warn }
  let running = false

  const reconcile = async () => {
    if (running) return 0
    running = true
    try {
      return await reconcileAutoClean(deps)
    } finally {
      running = false
    }
  }

  /**
   * Shared request gate: POST + JSON + same-origin, then a parsed body.
   * @param req - incoming request.
   * @param res - outgoing response.
   * @returns the parsed body, or undefined when a response was already sent.
   */
  const accept = async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, failure('method-not-allowed', '只允许使用 POST 访问自动化增强接口。'))
      return undefined
    }
    if (!isTrustedRequest(req)) {
      sendJson(res, 403, failure('forbidden', '请求未通过同源校验。'))
      return undefined
    }
    const contentType = req.headers['content-type']
    if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('application/json')) {
      sendJson(res, 415, failure('unsupported-media-type', '请求必须使用 JSON。'))
      return undefined
    }
    try {
      return await readJsonBody(req)
    } catch (error) {
      const tooLarge = error instanceof Error && error.message === 'request-too-large'
      sendJson(res, tooLarge ? 413 : 400, failure(
        tooLarge ? 'request-too-large' : 'invalid-json',
        tooLarge ? '请求过大。' : '请求不是有效 JSON。',
      ))
      return undefined
    }
  }

  const catalog = async (req, res) => {
    const body = await accept(req, res)
    if (body === undefined) return
    try {
      const tasks = await service.catalog()
      sendJson(res, 200, {
        ok: true,
        value: {
          tasks: tasks.map(rowOf),
          autoClean: { ...state.autoClean },
        },
      })
    } catch (error) {
      warn(`automation: catalog failed: ${String(error)}`)
      sendJson(res, 503, failure('schedule-unavailable', '读取自动化任务失败，请稍后重试。'))
    }
  }

  const autoClean = async (req, res) => {
    const body = await accept(req, res)
    if (body === undefined) return
    if (typeof body?.id !== 'string' || body.id.length === 0) {
      sendJson(res, 400, failure('invalid-id', '任务 ID 无效。'))
      return
    }
    try {
      const value = await setAutoClean(deps, { id: body.id, autoClean: body.autoClean === true })
      sendJson(res, 200, { ok: true, value })
    } catch (error) {
      warn(`automation: auto-clean toggle failed: ${String(error)}`)
      sendJson(res, 503, failure('schedule-unavailable', '更新自动清理设置失败。'))
    }
  }

  const remove = async (req, res) => {
    const body = await accept(req, res)
    if (body === undefined) return
    const ids = Array.isArray(body?.ids) ? body.ids.filter(id => typeof id === 'string' && id.length > 0) : []
    if (ids.length === 0) {
      sendJson(res, 400, failure('invalid-ids', '请选择要删除的任务。'))
      return
    }
    const deleted = []
    const failed = []
    for (const id of ids) {
      try {
        const result = await deleteTask(service, id)
        if (result.deleted) deleted.push(id)
        else failed.push({ id, code: result.code })
        delete state.autoClean[id]
      } catch (error) {
        failed.push({ id, message: error instanceof Error ? error.message : String(error) })
      }
    }
    save()
    sendJson(res, 200, { ok: true, value: { deleted, failed } })
  }

  const bind = async (req, res) => {
    const body = await accept(req, res)
    if (body === undefined) return
    if (typeof body?.id !== 'string' || body.id.length === 0 || !Array.isArray(body.sessionIds)) {
      sendJson(res, 400, failure('invalid-request', '请求参数无效。'))
      return
    }
    const sessionIds = body.sessionIds.filter(id => typeof id === 'string' && id.length > 0 && !id.includes('\0'))
    if (sessionIds.length === 0 || sessionIds.length > 50) {
      sendJson(res, 400, failure('invalid-sessions', '请选择 1 到 50 个会话。'))
      return
    }
    try {
      const result = await bindToSessions(deps, { id: body.id, sessionIds })
      sendJson(res, result.ok ? 200 : 409, result)
      if (result.ok) void reconcile()
    } catch (error) {
      warn(`automation: binding failed: ${String(error)}`)
      sendJson(res, 503, failure('schedule-unavailable', '创建任务失败，请稍后重试。'))
    }
  }

  return { handlers: { catalog, autoClean, remove, bind }, reconcile }
}
