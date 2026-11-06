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
  // Rule fields, so the panel can describe and re-edit the recurrence without
  // parsing a localized label.
  afterSeconds: typeof record.afterSeconds === 'number' ? record.afterSeconds : null,
  everySeconds: typeof record.everySeconds === 'number' ? record.everySeconds : null,
  time: typeof record.time === 'string' ? record.time : null,
  timeZone: typeof record.timeZone === 'string' ? record.timeZone : null,
  weekdays: Array.isArray(record.weekdays) ? [...record.weekdays] : null,
  expression: typeof record.expression === 'string' ? record.expression : null,
  rrule: typeof record.rrule === 'string' ? record.rrule : null,
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
 * Accept only a timing request this Host understands.
 * @param input - untrusted timing object.
 * @returns a ScheduleTiming request, or undefined.
 */
function sanitizeTiming(input) {
  if (input === null || typeof input !== 'object') return undefined
  const zone = typeof input.time_zone === 'string' && input.time_zone.length > 0 ? input.time_zone : undefined
  const withSeconds = (value) => (typeof value === 'string' && /^\d{2}:\d{2}$/.test(value) ? value + ':00' : value)
  const nestedZone = (value) => (typeof value?.time_zone === 'string' && value.time_zone.length > 0
    ? value.time_zone
    : zone)
  switch (input.kind) {
    case 'at':
      return typeof input.at === 'string' && input.at.length > 0 ? { kind: 'at', at: input.at } : undefined
    case 'after':
      return Number.isFinite(input.after_seconds) && input.after_seconds > 0
        ? { kind: 'after', after_seconds: Math.round(input.after_seconds) }
        : undefined
    case 'every':
      return Number.isFinite(input.every_seconds) && input.every_seconds >= 60
        ? { kind: 'every', every_seconds: Math.round(input.every_seconds) }
        : undefined
    case 'daily':
      return typeof input.daily?.time === 'string' && /^\d{2}:\d{2}(:\d{2})?$/.test(input.daily.time) && nestedZone(input.daily) !== undefined
        ? { kind: 'daily', daily: { time: withSeconds(input.daily.time), time_zone: nestedZone(input.daily) } }
        : undefined
    case 'weekly':
      return typeof input.weekly?.time === 'string'
        && /^\d{2}:\d{2}(:\d{2})?$/.test(input.weekly.time)
        && nestedZone(input.weekly) !== undefined
        && Array.isArray(input.weekly.weekdays)
        && input.weekly.weekdays.every(day => Number.isInteger(day) && day >= 0 && day <= 6)
        && input.weekly.weekdays.length > 0
        ? { kind: 'weekly', weekly: { time: withSeconds(input.weekly.time), time_zone: nestedZone(input.weekly), weekdays: [...input.weekly.weekdays] } }
        : undefined
    case 'cron':
      return typeof input.cron?.expression === 'string' && input.cron.expression.trim().length > 0 && nestedZone(input.cron) !== undefined
        ? { kind: 'cron', cron: { expression: input.cron.expression.trim(), time_zone: nestedZone(input.cron) } }
        : undefined
    case 'rrule':
      return typeof input.rrule === 'string' && input.rrule.trim().length > 0
        ? { kind: 'rrule', rrule: input.rrule }
        : undefined
    default:
      return undefined
  }
}

/**
 * Accept a destination this Host can store.
 * @param input - untrusted target object.
 * @returns a ScheduleTargetRequest, or undefined.
 */
function sanitizeTarget(input) {
  if (input === null || typeof input !== 'object') return undefined
  if (input.kind === 'session') {
    return typeof input.sessionId === 'string' && input.sessionId.length > 0
      ? { kind: 'session', sessionId: input.sessionId }
      : undefined
  }
  if (input.kind === 'new_once' || input.kind === 'new') {
    const create = {}
    if (typeof input.cwd === 'string' && input.cwd.length > 0) create.cwd = input.cwd
    if (typeof input.agentPreset === 'string' && input.agentPreset.length > 0) create.agentPreset = input.agentPreset
    return Object.keys(create).length > 0 ? { kind: input.kind, create } : { kind: input.kind }
  }
  return undefined
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
 * Create one copy of each requested task for every requested conversation.
 *
 * A conversation that already takes part in a task (its current target or any
 * earlier copy) is skipped, so binding twice never duplicates a reminder, and a
 * one-shot rule whose moment has already passed is refused instead of being
 * cloned into a copy that would fire at once.
 * @param deps - service access.
 * @param request - `{ids, sessionIds}`.
 * @returns created tasks, per-task failures, and the skipped conversations.
 */
async function bindToSessions({ service, state, save }, request) {
  const tasks = await service.catalog()
  const byId = new Map(tasks.map(task => [task.id, task]))
  const sessionIds = []
  for (const sessionId of request.sessionIds) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) continue
    if (!sessionIds.includes(sessionId)) sessionIds.push(sessionId)
  }
  if (sessionIds.length === 0) {
    return { ok: false, error: { code: 'no-sessions', message: '请至少选择一个会话。' } }
  }

  const created = []
  const failed = []
  const skipped = []
  for (const sourceId of request.ids) {
    const source = byId.get(sourceId)
    if (source === undefined) {
      failed.push({ id: sourceId, message: '任务不存在或已删除。' })
      continue
    }
    const timing = timingOf(source)
    if (timing === undefined) {
      failed.push({ id: sourceId, message: '该任务的重复规则无法复制到其他会话。' })
      continue
    }
    if (timing.kind === 'at' && Number.isFinite(Date.parse(timing.at)) && Date.parse(timing.at) <= Date.now()) {
      failed.push({ id: sourceId, message: '该一次性任务的时间已过，请先修改时间再绑定。' })
      continue
    }
    const involved = new Set(Array.isArray(source.involvedSessionIds) ? source.involvedSessionIds : [])
    if (source.target?.kind === 'session') involved.add(source.target.sessionId)
    // A copy this feature created earlier keeps its own identity, so the source
    // never learns about it: match the stored copies by title and instruction
    // instead, or binding twice would pile up identical reminders.
    for (const task of tasks) {
      if (task.id === source.id) continue
      if (task.title !== source.title || task.prompt !== source.prompt) continue
      if (task.target?.kind !== 'session') continue
      involved.add(task.target.sessionId)
    }
    for (const sessionId of sessionIds) {
      if (involved.has(sessionId)) {
        skipped.push({ id: sourceId, sessionId, reason: 'already-bound' })
        continue
      }
      try {
        const record = await service.create({
          title: source.title,
          prompt: source.prompt,
          timing,
          target: { kind: 'session', sessionId },
        })
        created.push({ id: record.id, sessionId, sourceId })
        if (state.autoClean[source.id] === true) state.autoClean[record.id] = true
      } catch (error) {
        failed.push({ id: sourceId, sessionId, message: error instanceof Error ? error.message : String(error) })
      }
    }
  }
  if (created.length > 0) save()
  return { ok: true, value: { created, failed, skipped } }
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

  const create = async (req, res) => {
    const body = await accept(req, res)
    if (body === undefined) return
    const title = typeof body?.title === 'string' ? body.title.trim() : ''
    const prompt = typeof body?.prompt === 'string' ? body.prompt : ''
    const timing = sanitizeTiming(body?.timing)
    const target = body?.target === undefined ? undefined : sanitizeTarget(body.target)
    if (title.length === 0 || title.length > 200 || prompt.trim().length === 0 || prompt.length > 20000) {
      sendJson(res, 400, failure('invalid-task', '请填写任务名称与内容，名称不超过 200 字。'))
      return
    }
    if (timing === undefined) {
      sendJson(res, 400, failure('invalid-timing', '重复规则无效，请检查时间设置。'))
      return
    }
    if (body?.target !== undefined && target === undefined) {
      sendJson(res, 400, failure('invalid-target', '执行位置无效。'))
      return
    }
    try {
      const record = await service.create({
        title,
        prompt,
        timing,
        ...(target === undefined ? {} : { target }),
      })
      if (body?.autoClean === true) {
        state.autoClean[record.id] = true
        save()
      }
      sendJson(res, 200, { ok: true, value: rowOf(record) })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      warn(`automation: create failed: ${message}`)
      sendJson(res, 409, failure('schedule-create-failed', message))
    }
  }

  const update = async (req, res) => {
    const body = await accept(req, res)
    if (body === undefined) return
    const id = typeof body?.id === 'string' ? body.id : ''
    if (id.length === 0) {
      sendJson(res, 400, failure('invalid-id', '任务 ID 无效。'))
      return
    }
    const patch = {}
    if (typeof body.title === 'string') patch.title = body.title.trim()
    if (typeof body.prompt === 'string') patch.prompt = body.prompt
    if (typeof body.active === 'boolean') patch.active = body.active
    if (body.timing !== undefined) {
      const timing = sanitizeTiming(body.timing)
      if (timing === undefined) {
        sendJson(res, 400, failure('invalid-timing', '重复规则无效，请检查时间设置。'))
        return
      }
      patch.timing = timing
    }
    if (body.target !== undefined) {
      const target = sanitizeTarget(body.target)
      if (target === undefined) {
        sendJson(res, 400, failure('invalid-target', '执行位置无效。'))
        return
      }
      patch.target = target
    }
    const wantsAutoClean = typeof body.autoClean === 'boolean'
    if (Object.keys(patch).length === 0 && !wantsAutoClean) {
      sendJson(res, 400, failure('empty-patch', '没有需要保存的改动。'))
      return
    }
    try {
      const result = Object.keys(patch).length === 0
        ? await service.view({ id })
        : await service.edit({ id, action: 'update', patch })
      if (result?.code === 'schedule_not_found') {
        sendJson(res, 404, failure('schedule_not_found', '任务不存在或已删除。'))
        return
      }
      if (result?.code === 'schedule_conflict') {
        sendJson(res, 409, failure('schedule_conflict', '任务已被其他位置修改，请刷新后重试。'))
        return
      }
      if (wantsAutoClean) {
        if (body.autoClean) state.autoClean[id] = true
        else delete state.autoClean[id]
        save()
      }
      sendJson(res, 200, { ok: true, value: rowOf(result) })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      warn(`automation: update failed: ${message}`)
      sendJson(res, 409, failure('schedule-update-failed', message))
    }
  }

  const run = async (req, res) => {
    const body = await accept(req, res)
    if (body === undefined) return
    const id = typeof body?.id === 'string' ? body.id : ''
    if (id.length === 0) {
      sendJson(res, 400, failure('invalid-id', '任务 ID 无效。'))
      return
    }
    try {
      const result = await service.run({ id })
      if (result?.code === 'schedule_not_found') {
        sendJson(res, 404, failure('schedule_not_found', '任务不存在或已删除。'))
        return
      }
      if (result?.code === 'schedule_execution_pending') {
        sendJson(res, 409, failure('schedule_execution_pending', '该任务正在投递中，请稍后再试。'))
        return
      }
      sendJson(res, 200, { ok: true, value: rowOf(result) })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      warn(`automation: run failed: ${message}`)
      sendJson(res, 409, failure('schedule-run-failed', message))
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
    const rawIds = Array.isArray(body?.ids) ? body.ids : [body?.id]
    const ids = []
    for (const id of rawIds) {
      if (typeof id === 'string' && id.length > 0 && !ids.includes(id)) ids.push(id)
    }
    if (ids.length === 0 || !Array.isArray(body?.sessionIds)) {
      sendJson(res, 400, failure('invalid-request', '请求参数无效。'))
      return
    }
    if (ids.length > 100) {
      sendJson(res, 400, failure('invalid-ids', '一次最多绑定 100 个任务。'))
      return
    }
    const sessionIds = body.sessionIds.filter(id => typeof id === 'string' && id.length > 0 && !id.includes('\0'))
    if (sessionIds.length === 0 || sessionIds.length > 50) {
      sendJson(res, 400, failure('invalid-sessions', '请选择 1 到 50 个会话。'))
      return
    }
    try {
      const result = await bindToSessions(deps, { ids, sessionIds })
      sendJson(res, result.ok ? 200 : 409, result)
      if (result.ok) void reconcile()
    } catch (error) {
      warn(`automation: binding failed: ${String(error)}`)
      sendJson(res, 503, failure('schedule-unavailable', '创建任务失败，请稍后重试。'))
    }
  }

  return { handlers: { catalog, create, update, run, autoClean, remove, bind }, reconcile }
}
