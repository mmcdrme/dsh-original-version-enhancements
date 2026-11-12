// Regression tests for the "deliver now" mechanism.
//
// The first attempt is always the Host's own delivery: it reaches the exact
// destination and records the run. Only a task the Host holds inside its
// delivery interval falls back to the enhancer's route, and only after the human
// accepts that the fallback delivery may leave no run record: the Host then
// creates a short lived clone two seconds out, the panel never lists that clone,
// and the clone deletes itself once its delivery settles. A clone orphaned by a
// reload or crash is reclaimed by the reconciler instead of lingering hidden.
// A `new_once` task is always delivered by the Host: its destination does not
// exist yet, so delivery creates it and the task adopts that conversation.

import assert from 'node:assert/strict'
import test from 'node:test'

const moduleUrl = new URL('../host/automation.mjs', import.meta.url)
const {
  createAutomationSurface, sameTiming, targetOf, targetRequestOf, timingOf,
} = await import(moduleUrl)

const NOW = Date.now()

/** One task the panel would have listed before the deliver action. */
const baseTask = () => ({
  id: 'task-1',
  title: 'Deploy check',
  prompt: 'Check the deployment.',
  kind: 'every',
  status: 'active',
  scheduledAt: '2099-01-01T00:00:00.000Z',
  everySeconds: 3600,
  target: { kind: 'session', sessionId: 'session-1' },
  involvedSessionIds: ['session-1'],
  updatedAt: '2026-01-01T00:00:00.000Z',
})

/**
 * A Schedule service fake whose `create` delivers shortly after the clone is
 * stored, the way the Host scheduler would.
 */
const makeService = (initial) => {
  const tasks = initial.map(task => ({ ...task }))
  const service = {
    tasks,
    created: [],
    edits: [],
    async catalog() {
      return tasks.map(task => ({ ...task }))
    },
    async create(request) {
      const id = `clone-${service.created.length + 1}`
      const task = {
        id,
        title: request.title,
        prompt: request.prompt,
        kind: 'at',
        status: 'active',
        scheduledAt: request.timing.at,
        target: request.target,
        involvedSessionIds: [],
        createdAt: new Date().toISOString(),
      }
      tasks.push(task)
      service.created.push(task)
      setTimeout(() => {
        task.status = 'ended'
        task.lastDelivery = {
          messageId: `message-${id}`,
          deliveredAt: new Date().toISOString(),
          scheduledAt: task.scheduledAt,
          targetSessionId: request.target.kind === 'session' ? request.target.sessionId : '',
        }
      }, 10)
      return task
    },
    async edit(request) {
      service.edits.push(request)
      const { id, action } = request
      const index = tasks.findIndex(task => task.id === id)
      if (index < 0) return { id, code: 'schedule_not_found' }
      if (action === 'delete') {
        tasks.splice(index, 1)
        return { deleted: true }
      }
      const current = tasks[index]
      if (request.expectedUpdatedAt !== undefined
        && request.expectedUpdatedAt !== (current.updatedAt ?? null)) {
        return { id, code: 'schedule_conflict' }
      }
      const patch = request.patch ?? {}
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'timing') continue
        current[key] = value
      }
      if (patch.timing !== undefined) current.kind = patch.timing.kind
      current.updatedAt = new Date(Date.now() + 1000).toISOString()
      return { ...current }
    },
    async view(request) {
      const task = tasks.find(candidate => candidate.id === request.id)
      return task === undefined ? { id: request.id, code: 'schedule_not_found' } : { ...task }
    },
    async history(request) {
      service.historyCalls.push(request.id)
      const task = tasks.find(candidate => candidate.id === request.id)
      return { records: Array.isArray(task?.receipts) ? task.receipts : [] }
    },
  }
  service.historyCalls = []
  return service
}

/** Call one route handler with a JSON POST and resolve its parsed answer. */
const call = (handler, payload) => new Promise((resolve) => {
  const request = {
    method: 'POST',
    headers: {
      host: '127.0.0.1:4936',
      origin: 'http://127.0.0.1:4936',
      'content-type': 'application/json',
    },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(payload))
    },
  }
  const response = {
    statusCode: 0,
    writeHead(status) {
      this.statusCode = status
    },
    end(text) {
      resolve({ status: this.statusCode, body: JSON.parse(text) })
    },
  }
  handler(request, response)
})

const makeSurface = (service, state) => createAutomationSurface({
  service,
  state,
  save: () => {},
  isTrustedRequest: () => true,
  warn: () => {},
})

test('the first delivery goes through the Host and records the run', async () => {
  const original = baseTask()
  const service = makeService([original])
  const state = { version: 2, autoClean: {}, ephemeral: {} }
  const runs = []
  service.run = async (request) => {
    runs.push(request)
    const task = service.tasks[0]
    task.lastDelivery = {
      messageId: 'message-host',
      deliveredAt: new Date().toISOString(),
      scheduledAt: new Date().toISOString(),
      targetSessionId: 'session-1',
    }
    return { ...task, lastDelivery: { ...task.lastDelivery } }
  }
  const surface = makeSurface(service, state)

  const result = await call(surface.handlers.run, { id: 'task-1' })

  assert.equal(result.status, 200)
  // No clone, no hidden bookkeeping: the Host delivered and recorded it.
  assert.deepEqual(runs, [{ id: 'task-1' }])
  assert.deepEqual(service.created, [])
  assert.deepEqual(service.edits, [])
  assert.deepEqual(state.ephemeral, {})
  assert.equal(result.body.value.lastDelivery.messageId, 'message-host')
  assert.equal(result.body.value.deliveryFloorEndsAt, null)
})

test('a task inside the delivery interval asks before the fallback', async () => {
  // The Host reports "pending" both while executing and inside the interval;
  // only the row's delivery floor makes it an interval refusal.
  const service = makeService([{ ...baseTask(), deliveryFloorEndsAt: new Date(Date.now() + 30_000).toISOString() }])
  service.run = async () => ({ id: 'task-1', code: 'schedule_execution_pending' })
  const state = { version: 2, autoClean: {}, ephemeral: {} }
  const surface = makeSurface(service, state)

  const result = await call(surface.handlers.run, { id: 'task-1' })

  assert.equal(result.status, 409)
  assert.equal(result.body.error.code, 'schedule-delivery-interval')
  assert.deepEqual(service.created, [])
  assert.deepEqual(state.ephemeral, {})
})

test('a task that is executing is refused instead of offering a duplicate delivery', async () => {
  // A queued/running delivery and the interval both report `pending`. Only the
  // interval may fall back to a clone: cloning an executing task sends the same
  // reminder twice.
  const service = makeService([{ ...baseTask(), executionActive: true }])
  service.run = async () => ({ id: 'task-1', code: 'schedule_execution_pending' })
  const state = { version: 2, autoClean: {}, ephemeral: {} }
  const surface = makeSurface(service, state)

  const result = await call(surface.handlers.run, { id: 'task-1', withinInterval: true })

  assert.equal(result.status, 409)
  assert.equal(result.body.error.code, 'schedule-execution-active')
  assert.deepEqual(service.created, [])
  assert.deepEqual(service.edits, [])
  assert.deepEqual(state.ephemeral, {})
})

test('a task that is executing is refused before the Host is even asked', async () => {
  const service = makeService([{ ...baseTask(), executionActive: true }])
  const runs = []
  service.run = async (request) => {
    runs.push(request)
    return { id: 'task-1', code: 'schedule_execution_pending' }
  }
  const surface = makeSurface(service, { version: 2, autoClean: {}, ephemeral: {} })

  const result = await call(surface.handlers.run, { id: 'task-1' })

  assert.equal(result.status, 409)
  assert.equal(result.body.error.code, 'schedule-execution-active')
  assert.deepEqual(runs, [])
})

test('a confirmed retry inside the interval clones the task two seconds out', async () => {
  const original = baseTask()
  original.deliveryFloorEndsAt = new Date(Date.now() + 30_000).toISOString()
  const service = makeService([original])
  const state = { version: 2, autoClean: {}, ephemeral: {} }
  service.run = async () => ({ id: 'task-1', code: 'schedule_execution_pending' })
  const surface = makeSurface(service, state)

  const before = Date.now()
  const result = await call(surface.handlers.run, { id: 'task-1', withinInterval: true })
  const after = Date.now()

  assert.equal(result.status, 200)
  assert.equal(service.created.length, 1)
  const clone = service.created[0]
  const at = Date.parse(clone.scheduledAt)
  assert.ok(at >= before + 1500, `clone fires too soon: ${clone.scheduledAt}`)
  assert.ok(at <= after + 4000, `clone fires too late: ${clone.scheduledAt}`)
  assert.equal(clone.title, original.title)
  assert.equal(clone.prompt, original.prompt)
  assert.deepEqual(clone.target, original.target)

  // The clone has been deleted by the request itself, and its hidden flag with it.
  assert.deepEqual(service.tasks.map(task => task.id), ['task-1'])
  assert.deepEqual(state.ephemeral, {})
  // Only the clone was touched: the source task was never edited or rescheduled.
  assert.deepEqual(service.edits.map(edit => edit.action), ['delete'])
  assert.equal(service.edits[0].id, clone.id)

  // The source task kept its own rule and status, and got no run record.
  assert.equal(service.tasks[0].status, 'active')
  assert.equal(service.tasks[0].scheduledAt, original.scheduledAt)
  assert.equal(service.tasks[0].everySeconds, 3600)
  assert.equal(service.tasks[0].lastDelivery, undefined)
})

test('the panel catalog hides an ephemeral clone', async () => {
  const original = baseTask()
  const clone = {
    ...baseTask(),
    id: 'clone-1',
    title: 'Deploy check',
    kind: 'at',
    scheduledAt: new Date(NOW + 2000).toISOString(),
  }
  const service = makeService([original, clone])
  const state = {
    version: 2,
    autoClean: {},
    ephemeral: { 'clone-1': { sourceId: 'task-1', createdAt: new Date().toISOString() } },
  }
  const surface = makeSurface(service, state)

  const result = await call(surface.handlers.catalog, {})

  assert.equal(result.status, 200)
  assert.deepEqual(result.body.value.tasks.map(task => task.id), ['task-1'])
  assert.equal(result.body.value.records['clone-1'], undefined)
})

test('a copy index is dropped once its source task is gone', async () => {
  // The copies may still exist as ordinary tasks, but the index only serves the
  // source task's "already bound" dialog — keeping it would grow the sidecar
  // forever and name a task that cannot be opened.
  const copy = { ...baseTask(), id: 'task-copy', title: 'Copy of the check' }
  const service = makeService([copy])
  const state = {
    version: 2,
    autoClean: {},
    ephemeral: {},
    copies: { 'task-gone': ['task-copy'] },
  }
  const surface = makeSurface(service, state)

  await surface.reconcile()

  assert.deepEqual(state.copies, {})
})

test('reconcile reclaims a stale ephemeral clone but leaves a fresh one alone', async () => {
  const stale = baseTask()
  stale.id = 'clone-stale'
  stale.status = 'ended'
  stale.lastDelivery = { messageId: 'message-stale', deliveredAt: new Date().toISOString() }
  const fresh = baseTask()
  fresh.id = 'clone-fresh'
  fresh.scheduledAt = new Date(Date.now() + 1000).toISOString()
  const service = makeService([baseTask(), stale, fresh])
  const state = {
    version: 2,
    autoClean: {},
    ephemeral: {
      'clone-stale': { sourceId: 'task-1', createdAt: new Date(Date.now() - 60_000).toISOString() },
      'clone-fresh': { sourceId: 'task-1', createdAt: new Date().toISOString() },
    },
  }
  const surface = makeSurface(service, state)

  const removed = await surface.reconcile()

  assert.equal(removed, 1)
  assert.deepEqual(service.tasks.map(task => task.id).sort(), ['clone-fresh', 'task-1'])
  assert.equal(state.ephemeral['clone-stale'], undefined)
  assert.notEqual(state.ephemeral['clone-fresh'], undefined)
})

test('deliver now of a new_once task adopts the conversation the Host creates', async () => {
  const original = baseTask()
  original.target = { kind: 'new_once', sessionId: 'session-reserved', create: { cwd: 'C:/work/project' } }
  original.involvedSessionIds = ['session-reserved']
  const service = makeService([original])
  const state = { version: 2, autoClean: {}, ephemeral: {} }
  const runs = []
  // Mirror the Host: the first delivery creates the reserved Session and rewrites
  // the task's destination to the conversation that delivery actually reached.
  service.run = async (request) => {
    runs.push(request)
    const task = service.tasks[0]
    task.target = { kind: 'session', sessionId: 'session-created' }
    task.involvedSessionIds = [...new Set([...task.involvedSessionIds, 'session-created'])]
    task.lastDelivery = {
      messageId: 'message-run',
      deliveredAt: new Date().toISOString(),
      scheduledAt: new Date().toISOString(),
      targetSessionId: 'session-created',
    }
    return { ...task, target: { ...task.target }, lastDelivery: { ...task.lastDelivery } }
  }
  const surface = makeSurface(service, state)

  const result = await call(surface.handlers.run, { id: 'task-1' })

  assert.equal(result.status, 200)
  // The Host delivered it, so no clone was created, hidden or deleted.
  assert.deepEqual(runs, [{ id: 'task-1' }])
  assert.deepEqual(service.created, [])
  assert.deepEqual(service.edits, [])
  assert.deepEqual(state.ephemeral, {})
  // The panel row now names the conversation the delivery created, and the rule
  // itself was not moved.
  assert.deepEqual(result.body.value.target, { kind: 'session', sessionId: 'session-created' })
  assert.equal(result.body.value.lastDelivery.targetSessionId, 'session-created')
  assert.equal(service.tasks[0].scheduledAt, original.scheduledAt)
})

test('deliver now reports a new_once task that is still executing', async () => {
  const original = baseTask()
  original.target = { kind: 'new_once', sessionId: 'session-reserved' }
  const service = makeService([original])
  service.run = async () => ({ id: 'task-1', code: 'schedule_execution_pending' })
  const surface = makeSurface(service, { version: 2, autoClean: {}, ephemeral: {} })

  const result = await call(surface.handlers.run, { id: 'task-1' })

  assert.equal(result.status, 409)
  assert.equal(result.body.error.code, 'schedule_execution_pending')
  assert.deepEqual(service.created, [])
})

test('deliver now refuses a new_once task when the Host cannot run one', async () => {
  const original = baseTask()
  original.target = { kind: 'new_once', sessionId: 'session-reserved' }
  const service = makeService([original])
  const surface = makeSurface(service, { version: 2, autoClean: {}, ephemeral: {} })

  const result = await call(surface.handlers.run, { id: 'task-1' })

  assert.equal(result.status, 409)
  assert.equal(result.body.error.code, 'schedule-run-failed')
  assert.deepEqual(service.created, [])
})

test('targetRequestOf never clones a new_once destination', () => {
  // The Host reserves a fresh Session id for every `new_once` request, so a clone
  // would open a second conversation instead of the task's reserved one.
  assert.equal(targetRequestOf({
    target: {
      kind: 'new_once',
      sessionId: 'session-reserved',
      create: { cwd: 'C:/work/project', agentPreset: 'standard' },
    },
  }), undefined)

  assert.deepEqual(targetRequestOf({
    target: { kind: 'new', create: { cwd: 'C:/work/project', agentPreset: 'standard' } },
  }), {
    kind: 'new',
    create: { cwd: 'C:/work/project', agentPreset: 'standard' },
  })

  assert.deepEqual(targetRequestOf({ target: { kind: 'session', sessionId: 'session-1' } }), {
    kind: 'session',
    sessionId: 'session-1',
  })
})

test('readAutomationState tolerates a sidecar written by the previous build', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { readAutomationState } = await import(moduleUrl)

  const directory = await mkdtemp(join(tmpdir(), 'ove-automation-'))
  const file = join(directory, 'state.json')
  await writeFile(file, JSON.stringify({ version: 1, autoClean: { 'task-1': true } }))

  const state = readAutomationState(file, () => {})
  assert.deepEqual(state.autoClean, { 'task-1': true })
  assert.deepEqual(state.ephemeral, {})
  assert.deepEqual(state.copies, {})
})

test('a sidecar write is atomic and keeps the previous generation', async () => {
  const { mkdtemp, readdir, readFile, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { readAutomationState, writeAutomationState } = await import(moduleUrl)

  const directory = await mkdtemp(join(tmpdir(), 'ove-automation-'))
  const file = join(directory, 'state.json')
  await writeFile(file, JSON.stringify({ version: 1, autoClean: { 'task-1': true }, copies: { 'task-1': ['session-a'] } }))

  const next = { version: 1, autoClean: { 'task-2': true }, ephemeral: {}, copies: { 'task-1': ['session-a'] } }
  assert.equal(writeAutomationState(file, next, () => {}), true)
  assert.deepEqual(readAutomationState(file, () => {}).autoClean, { 'task-2': true })
  // No half-written temporary file is left behind, and the prior generation is
  // recoverable when the current one is truncated.
  const files = await readdir(directory)
  assert.equal(files.some(name => name.endsWith('.tmp')), false)
  assert.equal(files.includes('state.json.bak'), true)
  await writeFile(file, '{"version":1,"autoClean":{"task-2":tru', 'utf8')
  const warnings = []
  const recovered = readAutomationState(file, message => warnings.push(message))
  assert.deepEqual(recovered.autoClean, { 'task-1': true })
  assert.deepEqual(recovered.copies, { 'task-1': ['session-a'] })
  assert.match(warnings.join('\n'), /recovered the sidecar from/)
  assert.match(await readFile(`${file}.bak`, 'utf8'), /task-1/)
})

test('editing an ended one-shot by title sends no rule change and no resume', async () => {
  // The Host treats `active: true` as a resume and a changed rule as a re-arm:
  // both fail on an ended one-shot, and the second silently resurrects an ended
  // recurring task. A title edit must therefore carry neither.
  const ended = {
    ...baseTask(),
    kind: 'at',
    status: 'ended',
    scheduledAt: '2026-01-01T10:00:00.000Z',
    everySeconds: undefined,
  }
  delete ended.everySeconds
  const service = makeService([ended])
  const surface = makeSurface(service, { version: 2, autoClean: {}, ephemeral: {} })

  const result = await call(surface.handlers.update, {
    id: 'task-1',
    title: 'Renamed',
    prompt: ended.prompt,
    timing: { kind: 'at', at: ended.scheduledAt },
    target: { kind: 'session', sessionId: 'session-1' },
  })

  assert.equal(result.status, 200)
  const patch = service.edits[0].patch
  assert.deepEqual(Object.keys(patch).sort(), ['prompt', 'target', 'title'])
  assert.equal(patch.active, undefined)
  assert.equal(patch.timing, undefined)
  assert.equal(service.tasks[0].title, 'Renamed')
})

test('a real rule change is still sent, with the revision it was rendered from', async () => {
  const original = baseTask()
  const service = makeService([original])
  const surface = makeSurface(service, { version: 2, autoClean: {}, ephemeral: {} })

  const result = await call(surface.handlers.update, {
    id: 'task-1',
    title: original.title,
    prompt: original.prompt,
    timing: { kind: 'every', every_seconds: 7200 },
    target: { kind: 'session', sessionId: 'session-1' },
    expectedUpdatedAt: original.updatedAt,
  })

  assert.equal(result.status, 200)
  const request = service.edits[0]
  assert.deepEqual(request.patch.timing, { kind: 'every', every_seconds: 7200 })
  assert.equal(request.expectedUpdatedAt, original.updatedAt)
})

test('a save rendered from a stale revision is reported as a conflict', async () => {
  const service = makeService([baseTask()])
  const surface = makeSurface(service, { version: 2, autoClean: {}, ephemeral: {} })

  const result = await call(surface.handlers.update, {
    id: 'task-1',
    title: 'Renamed',
    prompt: 'Check the deployment.',
    timing: { kind: 'every', every_seconds: 3600 },
    target: { kind: 'session', sessionId: 'session-1' },
    expectedUpdatedAt: '2000-01-01T00:00:00.000Z',
  })

  assert.equal(result.status, 409)
  assert.equal(result.body.error.code, 'schedule_conflict')
  assert.equal(service.tasks[0].title, 'Deploy check')
})

test('targetOf keeps the agent preset an edit must not drop', () => {
  assert.deepEqual(targetOf({
    target: { kind: 'new', create: { cwd: 'C:/work/project', agentPreset: 'standard' } },
  }), {
    kind: 'new',
    sessionId: undefined,
    cwd: 'C:/work/project',
    agentPreset: 'standard',
  })
  assert.equal(targetOf({ target: { kind: 'session', sessionId: 'session-1' } }).agentPreset, undefined)
})

test('binding recognises the copies it created by identity, not by title', async () => {
  // Two tasks share a title and instruction but deliver into different
  // conversations. The old title+prompt heuristic let one mark the other's
  // conversation as "already bound", so binding was skipped without ever
  // creating anything.
  const source = baseTask()
  const twin = { ...baseTask(), id: 'task-2', target: { kind: 'session', sessionId: 'session-2' } }
  const service = makeService([source, twin])
  const state = { version: 2, autoClean: {}, ephemeral: {}, copies: {} }
  const surface = makeSurface(service, state)

  const first = await call(surface.handlers.bind, { ids: ['task-1'], sessionIds: ['session-2'] })

  assert.equal(first.status, 200)
  assert.equal(first.body.value.created.length, 1)
  assert.deepEqual(first.body.value.skipped, [])
  const copyId = first.body.value.created[0].id
  assert.deepEqual(state.copies['task-1'], [copyId])

  // The catalog now tells the dialog that this conversation is covered.
  const catalog = await call(surface.handlers.catalog, {})
  const row = catalog.body.value.tasks.find(task => task.id === 'task-1')
  assert.deepEqual(row.copySessionIds, ['session-2'])

  const again = await call(surface.handlers.bind, { ids: ['task-1'], sessionIds: ['session-2'] })

  assert.equal(again.status, 200)
  assert.equal(again.body.value.created.length, 0)
  assert.deepEqual(again.body.value.skipped, [{ id: 'task-1', sessionId: 'session-2', reason: 'already-bound' }])
})

test('a stored clock is normalised before it is sent back to the Host', () => {
  // Schedule records keep `time` as `09:00:00.000`; a creation request accepts
  // `HH:mm[:ss]` only, so a rebuilt rule must be truncated to seconds.
  assert.deepEqual(timingOf({ kind: 'daily', time: '09:00:00.000', timeZone: 'Asia/Shanghai' }), {
    kind: 'daily',
    daily: { time: '09:00:00', time_zone: 'Asia/Shanghai' },
  })
  assert.deepEqual(timingOf({ kind: 'weekly', time: '7:05', timeZone: 'Asia/Shanghai', weekdays: [1, 3] }), {
    kind: 'weekly',
    weekly: { time: '07:05:00', time_zone: 'Asia/Shanghai', weekdays: [1, 3] },
  })
  // The same rule therefore compares equal whether it came from the record or
  // from the editor, so an unchanged rule is dropped instead of re-armed.
  assert.equal(
    sameTiming(
      { kind: 'daily', daily: { time: '09:00:00', time_zone: 'Asia/Shanghai' } },
      timingOf({ kind: 'daily', time: '09:00:00.000', timeZone: 'Asia/Shanghai' }),
    ),
    true,
  )
  assert.equal(
    sameTiming(
      { kind: 'daily', daily: { time: '10:00:00', time_zone: 'Asia/Shanghai' } },
      timingOf({ kind: 'daily', time: '09:00:00.000', timeZone: 'Asia/Shanghai' }),
    ),
    false,
  )
})

test('the catalog counts runs once per delivery instead of once per poll', async () => {
  const service = makeService([baseTask()])
  const surface = makeSurface(service, { version: 2, autoClean: {}, ephemeral: {} })

  const first = await call(surface.handlers.catalog, {})
  assert.equal(first.status, 200)
  assert.equal(service.historyCalls.length, 1)

  const second = await call(surface.handlers.catalog, {})
  assert.equal(second.status, 200)
  // Nothing about the task changed, so the count is reused.
  assert.equal(service.historyCalls.length, 1)

  service.tasks[0].lastDelivery = {
    messageId: 'message-new',
    deliveredAt: new Date().toISOString(),
    scheduledAt: service.tasks[0].scheduledAt,
    targetSessionId: 'session-1',
  }
  service.tasks[0].receipts = [{ messageId: 'message-new', deliveredAt: '2026-11-11T06:00:00.000Z' }]
  const third = await call(surface.handlers.catalog, {})
  assert.equal(third.status, 200)
  assert.equal(service.historyCalls.length, 2)
  assert.equal(third.body.value.records['task-1'], 1)
})
