// 原版功能增强 — Automation task enhancements.
// The shipped Automation tasks page (ui-schedule 0.2.x) already owns creation,
// filters, search, editing and records. This module adds the capabilities that
// page does not have, on top of the current Host Schedule service:
//   1. bulk deletion of selected tasks,
//   2. binding one task's rule to several conversations (one task per Session),
//   3. an auto-clean flag that removes a finished one-shot task after delivery,
//   4. a "deliver now" that first asks the Host to deliver (exact destination,
//      real run record) and falls back, only on request, to a clone two seconds
//      out when the Host's delivery interval blocks a second delivery.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const MAX_REQUEST_BYTES = 32 * 1024
const STATE_VERSION = 2
// The Host's own Schedule contract caps a task title at 120 characters. A
// longer one is refused there with an English 409, so the panel rejects it up
// front with a message the human can act on.
const MAX_TITLE_LENGTH = 120
const MAX_PROMPT_LENGTH = 20_000
// How long after creation the scheduler gets to run a "deliver now" clone.
const RUN_DELAY_MS = 2000
// A clone younger than this is never reclaimed by the background reconciler:
// the run request still owns it and will delete it once its delivery settles.
const EPHEMERAL_GRACE_MS = 30_000
// A clone that outlives this has missed its moment (plugin reload, crash) and
// is removed instead of lingering as an invisible task forever.
const EPHEMERAL_MAX_AGE_MS = 10 * 60_000

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
 * Keep only the string keys of an untrusted map.
 * @param value - untrusted value.
 * @returns a plain object.
 */
const stringKeyed = (value) => {
  const out = {}
  if (value === null || typeof value !== 'object') return out
  for (const [key, entry] of Object.entries(value)) {
    if (typeof key === 'string' && key.length > 0) out[key] = entry
  }
  return out
}

/**
 * Read the automation sidecar, tolerating a missing or malformed file.
 *
 * It stores only the bookkeeping this panel adds on top of the Host records:
 * auto-clean flags, the ids of the temporary "deliver now" clones that must stay
 * hidden from the panel, and the copies "bind to many Sessions" created so a
 * second binding recognises its own work by identity. Run records themselves are
 * read straight from the Host.
 * @param file - absolute sidecar path.
 * @param warn - diagnostic sink.
 * @returns the mutable state object.
 */
export function readAutomationState(file, warn) {
  // A document that parses but is not an object (`null`, `[]`, a string) is as
  // unusable as a truncated one; both have to fall back to the previous
  // generation instead of silently resetting the panel's index.
  const parse = (path) => {
    const parsed = JSON.parse(fs.readFileSync(path, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('sidecar is not a JSON object')
    }
    return parsed
  }
  let parsed
  try {
    parsed = parse(file)
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      // A truncated or corrupted sidecar must not silently reset the panel's
      // bookkeeping: the previous generation is kept as `.bak` on every write.
      warn(`automation: could not read ${file}: ${String(error)}`)
      try {
        parsed = parse(`${file}.bak`)
        warn(`automation: recovered the sidecar from ${file}.bak`)
      } catch { /* no usable backup either */ }
    }
  }
  if (parsed === undefined) return { version: STATE_VERSION, autoClean: {}, ephemeral: {}, copies: {} }

  const autoClean = {}
  for (const [id, value] of Object.entries(stringKeyed(parsed.autoClean))) {
    autoClean[id] = value === true
  }
  const ephemeral = {}
  for (const [id, value] of Object.entries(stringKeyed(parsed.ephemeral))) {
    if (value === null || typeof value !== 'object') continue
    ephemeral[id] = {
      sourceId: typeof value.sourceId === 'string' ? value.sourceId : '',
      createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
    }
  }
  const copies = {}
  for (const [id, value] of Object.entries(stringKeyed(parsed.copies))) {
    if (!Array.isArray(value)) continue
    const ids = value.filter(entry => typeof entry === 'string' && entry.length > 0)
    if (ids.length > 0) copies[id] = ids
  }
  return { version: STATE_VERSION, autoClean, ephemeral, copies }
}

/**
 * Persist the auto-clean sidecar; a failure is reported, never thrown.
 *
 * The write is atomic (temporary file + rename) and keeps the previous
 * generation as `.bak`: this file is the durable index of which tasks clean up
 * after delivery and which conversations a bulk binding already created, so a
 * half-written file would silently disable both.
 * @param file - absolute sidecar path.
 * @param state - the state object to store.
 * @param warn - diagnostic sink.
 * @returns whether the new state reached the disk.
 */
export function writeAutomationState(file, state, warn) {
  const usable = (path) => {
    try {
      const parsed = JSON.parse(fs.readFileSync(path, 'utf8'))
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    } catch {
      return false
    }
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temporary = `${file}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(state), 'utf8')
    // Only a usable generation may replace the backup: copying a corrupt main
    // over the last good `.bak` would destroy the only recoverable state (the
    // read path may have just recovered from it).
    if (fs.existsSync(file) && usable(file)) {
      try { fs.copyFileSync(file, `${file}.bak`) } catch { /* the new state is still written */ }
    }
    fs.renameSync(temporary, file)
    return true
  } catch (error) {
    warn(`automation: could not write ${file}: ${String(error)}`)
    return false
  }
}

/**
 * One stored clock reduced to `HH:mm:ss`.
 *
 * A Schedule record keeps its `time` with millisecond precision
 * (`09:00:00.000`), while a creation request accepts `HH:mm[:ss]` only.
 * @param value - stored clock.
 * @returns the normalised clock, or the value unchanged when it is not a clock.
 */
const clockOf = (value) => {
  if (typeof value !== 'string') return value
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/.exec(value.trim())
  return match === null ? value : `${match[1].padStart(2, '0')}:${match[2]}:${match[3] ?? '00'}`
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
        ? { kind: 'daily', daily: { time: clockOf(record.time), time_zone: record.timeZone } }
        : undefined
    case 'weekly':
      return typeof record.time === 'string'
        && typeof record.timeZone === 'string'
        && Array.isArray(record.weekdays)
        ? { kind: 'weekly', weekly: { time: clockOf(record.time), time_zone: record.timeZone, weekdays: [...record.weekdays] } }
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

/** Seconds of one instant, so a re-sent time is not "changed" by milliseconds. */
const instantOf = (value) => {
  const time = Date.parse(typeof value === 'string' ? value : '')
  return Number.isFinite(time) ? Math.round(time / 1000) : Number.NaN
}

/** Case- and whitespace-insensitive form of an RRULE body. */
const ruleKey = value => (typeof value === 'string' ? value : '')
  .split('\n')
  .map(line => line.trim().replace(/\s+/g, ' ').toUpperCase())
  .filter(line => line.length > 0)
  .join('\n')

/**
 * One timing request reduced to a comparable key.
 * @param timing - a ScheduleTiming request.
 * @returns a stable string, or undefined for an unsupported shape.
 */
const timingKey = (timing) => {
  if (timing === null || typeof timing !== 'object') return undefined
  switch (timing.kind) {
    case 'at':
      return `at:${instantOf(timing.at)}`
    case 'after':
      return `after:${Math.round(Number(timing.after_seconds))}`
    case 'every':
      return `every:${Math.round(Number(timing.every_seconds))}`
    case 'daily':
      return `daily:${clockOf(timing.daily?.time)}:${timing.daily?.time_zone}`
    case 'weekly': {
      const days = Array.isArray(timing.weekly?.weekdays) ? [...timing.weekly.weekdays].sort((left, right) => left - right) : []
      return `weekly:${clockOf(timing.weekly?.time)}:${timing.weekly?.time_zone}:${days.join(',')}`
    }
    case 'cron':
      return `cron:${String(timing.cron?.expression ?? '').trim().replace(/\s+/g, ' ')}:${timing.cron?.time_zone}`
    case 'rrule':
      return `rrule:${ruleKey(timing.rrule)}`
    default:
      return undefined
  }
}

/**
 * Whether two timing requests describe the same rule.
 *
 * An edit that only changes the title must not be sent as a rule change: the
 * Host treats a changed rule as a re-arm, which both rejects an ended one-shot
 * (`not_future`) and silently resurrects an ended recurring task.
 * @param left - a timing request.
 * @param right - another timing request.
 * @returns true when both produce the same schedule.
 */
export function sameTiming(left, right) {
  const key = timingKey(left)
  return key !== undefined && key === timingKey(right)
}

/**
 * Where a task delivers, in a form the Client can link and re-save.
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
    // Carried so editing a task cannot silently drop the preset it was created
    // with (the Host stores it in `target.create.agentPreset`).
    agentPreset: typeof create.agentPreset === 'string' && create.agentPreset.length > 0
      ? create.agentPreset
      : undefined,
  }
}

/**
 * The Host creation request that reproduces an existing destination.
 *
 * The catalog exposes a reduced target; this rebuilds the `create` request the
 * Schedule service accepts so a "deliver now" clone goes exactly where the
 * original task would have gone.
 *
 * A `new_once` target is deliberately refused: the Host reserves a *fresh*
 * Session identity for every `new_once` request, whatever id the caller sends,
 * so a clone would open a second conversation and leave the task's own reserved
 * one untouched. Such a task is delivered through the Host's own manual
 * execution instead.
 * @param record - one ScheduleCatalogEntry.
 * @returns a ScheduleTarget request, or undefined when a clone cannot reproduce the target.
 */
export function targetRequestOf(record) {
  const target = record?.target
  if (target?.kind === 'session') {
    return typeof target.sessionId === 'string' && target.sessionId.length > 0
      ? { kind: 'session', sessionId: target.sessionId }
      : undefined
  }
  if (target?.kind !== 'new') return undefined
  const request = { kind: 'new' }
  const create = {}
  if (typeof target.create?.cwd === 'string' && target.create.cwd.length > 0) create.cwd = target.create.cwd
  if (typeof target.create?.agentPreset === 'string' && target.create.agentPreset.length > 0) {
    create.agentPreset = target.create.agentPreset
  }
  if (Object.keys(create).length > 0) request.create = create
  return request
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
  // Present only while the Host's minimum delivery interval still runs; the
  // panel labels "deliver now" with "(interval)" until it passes.
  deliveryFloorEndsAt: typeof record.deliveryFloorEndsAt === 'string' ? record.deliveryFloorEndsAt : null,
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
 * Read one task's run records.
 * @param service - the Host Schedule service.
 * @param id - task identity.
 * @param prompt - the task instruction to attach to every receipt.
 * @returns the receipts, newest first.
 */
async function recordsOf(service, id, prompt = '') {
  const page = await service.history({ id, limit: 100 })
  if (page === undefined || page.code === 'schedule_not_found' || page.code === 'delivery_cursor_not_found') {
    return { records: [] }
  }
  const all = Array.isArray(page.records) ? page.records : []
  return {
    records: all.map(receipt => ({
      messageId: receipt.messageId,
      deliveredAt: receipt.deliveredAt,
      scheduledAt: receipt.scheduledAt,
      targetSessionId: receipt.targetSessionId,
      // The receipt's own prompt is the text that was delivered at that moment;
      // overwriting it with the task's current prompt rewrote history after an
      // edit. The fallback only covers a backend that omits the field.
      prompt: typeof receipt.prompt === 'string' && receipt.prompt.length > 0
        ? receipt.prompt
        : (typeof prompt === 'string' ? prompt : ''),
    })),
  }
}

/**
 * Poll the catalog until the task records a fresh delivery.
 * @param service - the Host Schedule service.
 * @param id - task identity.
 * @param previous - the delivery instant observed before the run.
 * @param timeoutMs - how long to keep polling.
 * @returns whether a new delivery showed up.
 */
async function waitForDelivery(service, id, previous, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    let task
    try {
      task = (await service.catalog()).find(candidate => candidate.id === id)
    } catch {
      return false
    }
    if (task === undefined) return false
    const deliveredAt = task.lastDelivery?.deliveredAt
    if (typeof deliveredAt === 'string' && deliveredAt !== previous) return true
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  return false
}

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
      // The Host's Schedule contract numbers weekdays the ISO way: 1 = Monday
      // … 7 = Sunday. A 0 is rejected there (`invalid_rule`), so accepting it
      // here would only turn a valid panel request into an English Host error.
      return typeof input.weekly?.time === 'string'
        && /^\d{2}:\d{2}(:\d{2})?$/.test(input.weekly.time)
        && nestedZone(input.weekly) !== undefined
        && Array.isArray(input.weekly.weekdays)
        && input.weekly.weekdays.every(day => Number.isInteger(day) && day >= 1 && day <= 7)
        && input.weekly.weekdays.length > 0
        ? { kind: 'weekly', weekly: { time: withSeconds(input.weekly.time), time_zone: nestedZone(input.weekly), weekdays: [...new Set(input.weekly.weekdays)].sort((left, right) => left - right) } }
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
 * Keep the sidecar in step with the Host task list.
 *
 * Auto-clean removes a finished one-shot task after its delivery; flags of
 * deleted tasks are dropped on the way. The same pass reclaims "deliver now"
 * clones whose run request never got to delete them (plugin reload, crash):
 * they are hidden, so an orphan would otherwise stay invisible forever.
 * @param deps - service access and sidecar state, plus a log sink.
 * @returns the number of removed tasks.
 */
export async function reconcileAutomation({ service, state, save, warn = () => {} }) {
  const cleanIds = Object.keys(state.autoClean)
  const ephemeral = state.ephemeral ?? (state.ephemeral = {})
  const ephemeralIds = Object.keys(ephemeral)
  const copies = state.copies ?? (state.copies = {})
  const copySources = Object.keys(copies)
  if (cleanIds.length === 0 && ephemeralIds.length === 0 && copySources.length === 0) return 0
  let removed = 0
  let changed = false
  let tasks
  try {
    tasks = await service.catalog()
  } catch (error) {
    warn(`automation: reconcile catalog failed: ${String(error)}`)
    return 0
  }
  const byId = new Map(tasks.map(task => [task.id, task]))

  for (const id of cleanIds) {
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

  const now = Date.now()
  for (const id of ephemeralIds) {
    const task = byId.get(id)
    if (task === undefined) {
      // Already gone (delivered-and-deleted, or removed by hand): just forget it.
      delete ephemeral[id]
      changed = true
      continue
    }
    const mark = ephemeral[id]
    const createdAt = Date.parse(mark?.createdAt ?? '')
    // The request that created this clone still owns it for a short while and
    // deletes it itself once the delivery settles; never race it.
    if (Number.isFinite(createdAt) && now - createdAt < EPHEMERAL_GRACE_MS) continue
    const scheduledAt = Date.parse(task.scheduledAt ?? '')
    const stale = Number.isFinite(createdAt) ? now - createdAt >= EPHEMERAL_MAX_AGE_MS : false
    const missed = Number.isFinite(scheduledAt) ? now - scheduledAt >= EPHEMERAL_GRACE_MS : false
    if (task.status !== 'ended' && !stale && !missed) continue
    try {
      const result = await deleteTask(service, id)
      if (result.deleted) removed += 1
      delete ephemeral[id]
      changed = true
    } catch (error) {
      warn(`automation: ephemeral delete failed for ${id}: ${String(error)}`)
    }
  }

  // Copies removed by hand (or by the Host) must not keep a Conversation marked
  // as already bound, so drop every id the catalog no longer lists.
  for (const sourceId of copySources) {
    // The index belongs to the task that created the copies. Once that task is
    // gone the panel can never offer "already bound" for it again, so the entry
    // is dropped even when its copies are still alive.
    if (!byId.has(sourceId)) {
      delete copies[sourceId]
      changed = true
      continue
    }
    const kept = copies[sourceId].filter(id => byId.has(id))
    if (kept.length === copies[sourceId].length) continue
    if (kept.length > 0) copies[sourceId] = kept
    else delete copies[sourceId]
    changed = true
  }

  if (changed) save()
  return removed
}

/** Backwards-compatible name for the reconciler. */
export const reconcileAutoClean = reconcileAutomation

/**
 * The copies "bind to many Sessions" created from one task.
 * @param state - the sidecar state.
 * @param sourceId - the task the copies were made from.
 * @returns the copy ids, possibly empty.
 */
const copiesOf = (state, sourceId) => (Array.isArray(state.copies?.[sourceId]) ? state.copies[sourceId] : [])

/**
 * Remember one created copy so a later binding recognises its own work.
 * @param state - the sidecar state.
 * @param sourceId - the task the copy was made from.
 * @param copyId - the created task identity.
 */
const rememberCopy = (state, sourceId, copyId) => {
  if (state.copies === undefined) state.copies = {}
  const ids = copiesOf(state, sourceId)
  if (ids.includes(copyId)) return
  state.copies[sourceId] = [...ids, copyId]
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
    // Copies this feature created earlier keep their own identity, so the source
    // never learns about them; the sidecar remembers which ids it created, and
    // that identity — never a title or instruction match — decides what is
    // already bound.
    for (const copyId of copiesOf(state, source.id)) {
      const copy = byId.get(copyId)
      if (copy?.target?.kind === 'session') involved.add(copy.target.sessionId)
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
        rememberCopy(state, source.id, record.id)
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
  // A sidecar written by an older build may miss any of these maps.
  if (state.autoClean === undefined) state.autoClean = {}
  if (state.ephemeral === undefined) state.ephemeral = {}
  if (state.copies === undefined) state.copies = {}
  // Run-record counts per task, keyed by the part of the row that can change
  // them. The panel polls the catalog every 20 s; without this, every poll cost
  // one `history()` call per task. The entry also expires: a task's revision and
  // last delivery say nothing about its history being trimmed, so a bounded age
  // keeps the displayed count from going stale forever.
  const RECORD_COUNT_TTL_MS = 60 * 1000
  const recordCounts = new Map()
  // One in-flight "deliver now" clone per task. Two tabs (or a retried request)
  // racing this branch used to build one clone each and deliver the reminder
  // twice; both requests were answered 200.
  const cloneRuns = new Set()
  let running = false

  const reconcile = async () => {
    if (running) return 0
    running = true
    try {
      return await reconcileAutomation(deps)
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
      // "Deliver now" clones are mirror images of a task the panel already
      // lists; they live only until their delivery settles, so keep them out of
      // every count, selection and search result here.
      const tasks = (await service.catalog())
        .filter(task => state.ephemeral?.[task.id] === undefined)
      const byId = new Map(tasks.map(task => [task.id, task]))
      // One record count per task drives the panel's "run records" line
      // without a second round trip, and only a task whose delivery changed is
      // asked again.
      const records = {}
      const seen = new Set()
      for (const task of tasks) {
        seen.add(task.id)
        const stamp = `${task.updatedAt ?? ''}|${task.lastDelivery?.messageId ?? ''}|${task.lastDelivery?.deliveredAt ?? ''}`
        const cached = recordCounts.get(task.id)
        const fresh = cached !== undefined && cached.stamp === stamp
          && Date.now() - cached.at < RECORD_COUNT_TTL_MS
        let count = fresh ? cached.count : undefined
        if (count === undefined) {
          count = (await recordsOf(service, task.id, task.prompt)).records.length
          recordCounts.set(task.id, { stamp, count, at: Date.now() })
        }
        records[task.id] = count
      }
      for (const id of [...recordCounts.keys()]) {
        if (!seen.has(id)) recordCounts.delete(id)
      }
      // Conversations a binding already covers, so the dialog never offers one
      // that would be skipped.
      const copiesOfTask = {}
      for (const [sourceId, ids] of Object.entries(state.copies ?? {})) {
        const sessions = ids
          .map(id => byId.get(id)?.target?.sessionId)
          .filter(sessionId => typeof sessionId === 'string' && sessionId.length > 0)
        if (sessions.length > 0) copiesOfTask[sourceId] = [...new Set(sessions)]
      }
      sendJson(res, 200, {
        ok: true,
        value: {
          tasks: tasks.map(task => ({
            ...rowOf(task),
            copySessionIds: copiesOfTask[task.id] ?? [],
          })),
          autoClean: { ...state.autoClean },
          records,
        },
      })
    } catch (error) {
      warn(`automation: catalog failed: ${String(error)}`)
      sendJson(res, 503, failure('schedule-unavailable', '读取自动化任务失败，请稍后重试。'))
    }
  }

  const history = async (req, res) => {
    const body = await accept(req, res)
    if (body === undefined) return
    if (typeof body?.id !== 'string' || body.id.length === 0) {
      sendJson(res, 400, failure('invalid-id', '任务 ID 无效。'))
      return
    }
    try {
      const task = (await service.catalog()).find(candidate => candidate.id === body.id)
      const page = await recordsOf(service, body.id, task?.prompt ?? '')
      sendJson(res, 200, {
        ok: true,
        value: { records: page.records },
      })
    } catch (error) {
      warn(`automation: history failed: ${String(error)}`)
      sendJson(res, 503, failure('schedule-unavailable', '读取运行记录失败，请稍后重试。'))
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
    if (title.length === 0 || title.length > MAX_TITLE_LENGTH || prompt.trim().length === 0 || prompt.length > MAX_PROMPT_LENGTH) {
      sendJson(res, 400, failure('invalid-task', `请填写任务名称与内容，名称不超过 ${MAX_TITLE_LENGTH} 字。`))
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
    if (typeof body.title === 'string') {
      const title = body.title.trim()
      if (title.length === 0 || title.length > MAX_TITLE_LENGTH) {
        sendJson(res, 400, failure('invalid-task', `任务名称不能为空，且不超过 ${MAX_TITLE_LENGTH} 字。`))
        return
      }
      patch.title = title
    }
    if (typeof body.prompt === 'string') {
      if (body.prompt.trim().length === 0 || body.prompt.length > MAX_PROMPT_LENGTH) {
        sendJson(res, 400, failure('invalid-task', '任务内容不能为空。'))
        return
      }
      patch.prompt = body.prompt
    }
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
    // Optimistic concurrency: the panel sends the revision it rendered, so a
    // second window that saved in between is reported instead of overwritten.
    const expectedUpdatedAt = typeof body.expectedUpdatedAt === 'string'
      ? body.expectedUpdatedAt
      : body.expectedUpdatedAt === null ? null : undefined
    if (Object.keys(patch).length === 0 && !wantsAutoClean) {
      sendJson(res, 400, failure('empty-patch', '没有需要保存的改动。'))
      return
    }
    // The Client always rebuilds the whole rule from the row it rendered. Sending
    // that rule back unchanged would look like a rule change to the Host — which
    // re-arms an ended task and rejects an ended one-shot as `not_future` — so
    // compare first and drop it when nothing changed.
    if (patch.timing !== undefined) {
      let current
      try {
        current = await service.view({ id })
      } catch (error) {
        warn(`automation: reading ${id} before an update failed: ${String(error)}`)
        sendJson(res, 503, failure('schedule-unavailable', '读取任务失败，请稍后重试。'))
        return
      }
      if (current === undefined || current.code === 'schedule_not_found') {
        sendJson(res, 404, failure('schedule_not_found', '任务不存在或已删除。'))
        return
      }
      if (sameTiming(patch.timing, timingOf(current))) delete patch.timing
    }
    try {
      const result = Object.keys(patch).length === 0
        ? await service.view({ id })
        : await service.edit({
          id,
          action: 'update',
          patch,
          ...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
        })
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

  /**
   * Why the Host refused an immediate delivery.
   *
   * The Host folds three different refusals into `schedule_execution_pending`:
   * the task is executing right now, it is still inside its minimum delivery
   * interval, or a previous delivery has not settled yet. They need different
   * answers — only the interval one may fall back to a clone, and only when the
   * caller asked for that — so the refusal is classified from a fresh row.
   * @param service - the Host Schedule service.
   * @param id - task identity.
   * @returns executing | interval | pending | missing | unknown.
   */
  const pendingReasonOf = async (service, id) => {
    let task
    try {
      task = (await service.catalog()).find(candidate => candidate.id === id)
    } catch (error) {
      warn(`automation: reading ${id} to classify a pending delivery failed: ${String(error)}`)
      return 'unknown'
    }
    if (task === undefined) return 'missing'
    if (task.executionActive === true) return 'executing'
    const floor = typeof task.deliveryFloorEndsAt === 'string' ? Date.parse(task.deliveryFloorEndsAt) : Number.NaN
    return Number.isFinite(floor) && floor > Date.now() ? 'interval' : 'pending'
  }

  /**
   * Deliver one task through the Host's own manual execution.
   *
   * This is the shipped mechanism: it records the delivery on the task, and for
   * a `new_once` task it creates the reserved conversation and rewrites the
   * task's destination to it. Exact destination and a real run record, so it is
   * always tried first.
   *
   * The Host refuses a task that is still executing, still inside its minimum
   * delivery interval, or whose previous delivery has not settled.
   * `intervalFallback` decides how the interval refusal is reported: as the
   * signal the panel turns into "deliver anyway?", or as a plain error for a
   * task that cannot be delivered twice (a `new_once` one). A task that is
   * executing is never a fallback: a clone would deliver the same reminder a
   * second time.
   * @param res - the HTTP response to answer.
   * @param task - the automation row.
   * @param intervalFallback - whether "inside the interval" is a fallback signal.
   */
  const runThroughHost = async (res, task, intervalFallback) => {
    if (typeof service.run !== 'function') {
      sendJson(res, 409, failure('schedule-run-failed', '当前宿主不支持立即投递，请升级宿主后重试。'))
      return
    }
    let result
    try {
      result = await service.run({ id: task.id })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      warn(`automation: running ${task.id} failed: ${message}`)
      sendJson(res, 409, failure('schedule-run-failed', `立即投递失败：${message}`))
      return
    }
    if (result === undefined || result.code === 'schedule_not_found') {
      sendJson(res, 404, failure('schedule_not_found', '任务不存在或已删除。'))
      return
    }
    if (result.code === 'schedule_execution_pending') {
      const reason = await pendingReasonOf(service, task.id)
      if (reason === 'missing') {
        sendJson(res, 404, failure('schedule_not_found', '任务不存在或已删除。'))
        return
      }
      if (reason === 'executing') {
        sendJson(res, 409, failure('schedule-execution-active', '该任务正在投递中，请等这次投递结束后再试。'))
        return
      }
      if (reason === 'interval' && intervalFallback) {
        sendJson(res, 409, failure('schedule-delivery-interval', '该任务仍在投递间隔内。'))
        return
      }
      sendJson(res, 409, failure('schedule_execution_pending', '该任务上一次投递尚未结束，请稍后再试。'))
      return
    }
    // The returned entry already carries the delivered destination, so the panel
    // reloads straight into the conversation the message landed in.
    sendJson(res, 200, { ok: true, value: rowOf(result) })
  }

  /**
   * Deliver a task now: the Host first, the clone only on demand.
   *
   * The first click always asks the Host, which delivers to the exact
   * destination and records the run. A task still inside its delivery interval
   * is refused there; the panel then warns that the fallback delivery may not be
   * recorded, and only a confirmed retry (`withinInterval: true`) takes the
   * enhancer's route: clone the task two seconds out, hide the clone from this
   * panel, and delete it once its delivery settles.
   *
   * A `new_once` task is always delivered by the Host, because its destination
   * does not exist yet and a clone would open a second conversation.
   */
  const run = async (req, res) => {
    const body = await accept(req, res)
    if (body === undefined) return
    const id = typeof body?.id === 'string' ? body.id : ''
    if (id.length === 0) {
      sendJson(res, 400, failure('invalid-id', '任务 ID 无效。'))
      return
    }
    const withinInterval = body?.withinInterval === true
    let task
    try {
      task = (await service.catalog()).find(candidate => candidate.id === id)
    } catch (error) {
      warn(`automation: reading the task list for ${id} failed: ${String(error)}`)
      sendJson(res, 503, failure('schedule-unavailable', '读取任务列表失败，请稍后重试。'))
      return
    }
    if (task === undefined) {
      sendJson(res, 404, failure('schedule_not_found', '任务不存在或已删除。'))
      return
    }
    if (typeof task.title !== 'string' || typeof task.prompt !== 'string') {
      sendJson(res, 409, failure('schedule-run-failed', '该任务的名称或内容无效，无法立即投递。'))
      return
    }
    // A delivery already queued or running owns this task's slot. Delivering
    // again here would send the same reminder twice, so refuse before the Host
    // ever sees the request.
    if (task.executionActive === true) {
      sendJson(res, 409, failure('schedule-execution-active', '该任务正在投递中，请等这次投递结束后再试。'))
      return
    }
    if (task.target?.kind === 'new_once' || !withinInterval) {
      await runThroughHost(res, task, task.target?.kind !== 'new_once')
      return
    }

    // The clone branch below takes a while (create + 2 s delivery + remove), so
    // two tabs clicking at once both passed the `executionActive` check before
    // either clone existed. One in-flight delivery per task, plus the persisted
    // mark for a clone whose delivery is still settling after a reload.
    const settling = Object.values(state.ephemeral ?? {}).some(entry => entry?.sourceId === id)
    if (cloneRuns.has(id) || settling) {
      sendJson(res, 409, failure('schedule-run-busy', '该任务正在投递中，请稍后再试。'))
      return
    }
    cloneRuns.add(id)
    try {
      let clone
      try {
        const target = targetRequestOf(task)
        if (target === undefined) {
          sendJson(res, 409, failure('schedule-run-failed', '该任务的执行位置无效，无法立即投递。'))
          return
        }
        clone = await service.create({
          title: task.title,
          prompt: task.prompt,
          timing: { kind: 'at', at: new Date(Date.now() + RUN_DELAY_MS).toISOString() },
          target,
        })
        state.ephemeral[clone.id] = { sourceId: task.id, createdAt: new Date().toISOString() }
        save()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        warn(`automation: run clone failed: ${message}`)
        sendJson(res, 409, failure('schedule-run-failed', `创建临时投递任务失败：${message}`))
        return
      }

      let delivered = false
      try {
        delivered = await waitForDelivery(service, clone.id, undefined)
      } catch (error) {
        warn(`automation: waiting for the clone of ${id} failed: ${String(error)}`)
      }
      // The clone exists only for this one delivery: remove it before answering,
      // whether or not the delivery was confirmed.
      let removed = false
      try {
        const result = await deleteTask(service, clone.id)
        removed = result.deleted || result.code === 'schedule_not_found'
      } catch (error) {
        warn(`automation: deleting the clone of ${id} failed: ${String(error)}`)
      }
      if (removed) {
        delete state.ephemeral[clone.id]
        save()
      }
      // Otherwise the mark stays so the reconciler can retry the removal; the
      // clone stays hidden from the panel in the meantime.

      if (!delivered) {
        sendJson(res, 409, failure('schedule-run-failed', '任务未能在两秒后完成投递，请稍后重试。'))
        return
      }
      try {
        const refreshed = (await service.catalog()).find(candidate => candidate.id === id)
        sendJson(res, 200, { ok: true, value: rowOf(refreshed ?? task) })
      } catch (error) {
        warn(`automation: refreshing ${id} after delivery failed: ${String(error)}`)
        sendJson(res, 200, { ok: true, value: rowOf(task) })
      }
    } finally {
      cloneRuns.delete(id)
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

  return { handlers: { catalog, history, create, update, run, autoClean, remove, bind }, reconcile }
}
