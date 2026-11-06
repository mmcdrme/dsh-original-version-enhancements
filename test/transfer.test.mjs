// Regression tests for the session transfer host path.
//
// A `move` must keep the source session's identity: the old implementation
// cloned the log under a fresh UUID, so the conversation became a different
// session (its links and open view stopped matching). These tests run against
// the real filesystem for the storage quarantine and a small fake persistence
// backend for the log itself.

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const moduleUrl = new URL('../host/transfer.mjs', import.meta.url)
const { transferSession } = await import(moduleUrl)

const SESSION_ID = 'session-12345678-1234-1234-1234-123456789abc'
const SOURCE_PATH = 'C:/work/project'
const TARGET_PATH = 'C:/work/target'
const HEADER = {
  version: 4,
  id: SESSION_ID,
  createdAt: 1_700_000_000_000,
  cwd: SOURCE_PATH,
  isSeeded: false,
  agentPreset: 'standard',
}
const EVENTS = [
  { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
  { type: 'user/message', seq: 1, time: 2, data: { message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } } },
  { type: 'turn/end', seq: 2, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
]

/** Lay out one source session exactly as the JSONL backend does. */
const makeSession = async () => {
  const root = await mkdtemp(join(tmpdir(), 'ove-move-'))
  const sessionDirectory = join(root, 'project', SESSION_ID)
  const transcript = join(sessionDirectory, 'session.jsonl')
  await mkdir(sessionDirectory, { recursive: true })
  await writeFile(transcript, `${JSON.stringify(HEADER)}\n`)
  return { root, sessionDirectory, transcript }
}

/**
 * Fake JSONL persistence: `open` serves the source log, `create` records the
 * recreated log under whatever id the host path asks for (which must stay the
 * source id), and `stat` reports the materialized copy.
 */
const makePersistence = ({ transcript, events, writeEvents, failCreate = false }) => {
  const state = { created: new Map(), openedWrite: false, closed: 0 }
  const persistence = {
    state,
    name: 'session-persistence-jsonl',
    async open(id, access) {
      if (access === 'write') state.openedWrite = true
      return {
        header: HEADER,
        read: async () => ({ events: access === 'write' ? writeEvents ?? events : events }),
        close: async () => { state.closed += 1 },
      }
    },
    async resolveCurrentLog() {
      return transcript
    },
    async stat(id) {
      const created = state.created.get(id)
      if (created !== undefined) {
        return { header: created.header, eventCount: created.events.length, sizeBytes: 10 }
      }
      return id === SESSION_ID ? { header: HEADER, location: { kind: 'jsonl', path: transcript } } : undefined
    },
    async list() {
      const headers = [HEADER, ...[...state.created.values()].map(entry => entry.header)]
      return headers.map(header => ({ header }))
    },
    async create(meta) {
      if (failCreate) throw new Error('disk is full')
      const entry = { header: meta, events: [] }
      state.created.set(meta.id, entry)
      return {
        header: meta,
        async append(batch) { entry.events.push(...batch) },
        async flush() {},
        async close() {},
      }
    },
  }
  return persistence
}

/** Fake Workspace entity with the registry surface the move path uses. */
const makeWorkspace = (id, path) => {
  const calls = []
  return {
    id,
    path,
    calls,
    async status() { return 'ok' },
    async attachSession(sessionId) { calls.push(['attach', sessionId]) },
    async detachSession(sessionId) { calls.push(['detach', sessionId]) },
  }
}

/** Fake Workspace registry exposing the header reindex hook. */
const makeRegistry = (source, target) => {
  const calls = { indexed: [], unarchived: [], unpinned: [] }
  return {
    calls,
    get(id) {
      return [source, target].find(workspace => workspace.id === id)
    },
    list() {
      return [source, target]
    },
    async resolveByPath(path) {
      return path === source.path ? source : undefined
    },
    async indexHeader(header) {
      calls.indexed.push(header)
    },
    async unarchiveSession(sessionId) {
      calls.unarchived.push(sessionId)
    },
    async unpinSession(sessionId) {
      calls.unpinned.push(sessionId)
    },
  }
}

const depsFor = ({ root, transcript, events, registry, cache, failCreate, writeEvents }) => ({
  workspaceRegistry: registry,
  sessionPersistence: makePersistence({ transcript, events, failCreate, writeEvents }),
  sessionProjectionCache: cache,
  sessions: { get: () => undefined },
  agents: { get: () => undefined },
  agentHandles: {},
  sessionRoot: root,
})

test('a move keeps the session id and only changes its workspace', async () => {
  const { root, sessionDirectory, transcript } = await makeSession()
  const source = makeWorkspace('ws-source', SOURCE_PATH)
  const target = makeWorkspace('ws-target', TARGET_PATH)
  const registry = makeRegistry(source, target)
  const cold = []
  const cache = { coldSnapshot: (meta, inherited, events) => { cold.push({ meta, inherited, events }) } }
  const deps = depsFor({ root, transcript, events: EVENTS, registry, cache })

  const result = await transferSession(deps, {
    sessionId: SESSION_ID,
    workspaceId: target.id,
    mode: 'move',
  })

  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.value.sessionId, SESSION_ID)
  assert.equal(result.value.workspaceId, target.id)
  assert.equal(result.value.mode, 'move')

  // The recreated log carries the SAME id and every event, filed under the target.
  const recreated = deps.sessionPersistence.state.created.get(SESSION_ID)
  assert.ok(recreated !== undefined, 'the moved session keeps its id')
  assert.equal(recreated.header.cwd, TARGET_PATH)
  assert.equal(recreated.header.createdAt, HEADER.createdAt)
  assert.equal(recreated.header.agentPreset, 'standard')
  assert.equal(recreated.events.length, EVENTS.length)

  // The Workspace registry was re-indexed and the target now owns the session.
  assert.equal(registry.calls.indexed.length, 1)
  assert.equal(registry.calls.indexed[0].cwd, TARGET_PATH)
  assert.deepEqual(target.calls, [['attach', SESSION_ID]])
  assert.deepEqual(source.calls, [['detach', SESSION_ID]])
  assert.deepEqual(registry.calls.unarchived, [SESSION_ID])
  assert.deepEqual(registry.calls.unpinned, [SESSION_ID])

  // The cached projection follows the moved identity under the same id.
  assert.equal(cold.length, 1)
  assert.equal(cold[0].meta.id, SESSION_ID)
  assert.equal(cold[0].meta.cwd, TARGET_PATH)

  // The source storage is gone; the write lease was taken and released.
  await assert.rejects(stat(sessionDirectory), error => error.code === 'ENOENT')
  assert.equal(deps.sessionPersistence.state.openedWrite, true)
  assert.ok(deps.sessionPersistence.state.closed >= 1)
  await rm(root, { recursive: true, force: true })
})

test('a failed move restores the original session directory', async () => {
  const { root, transcript } = await makeSession()
  const source = makeWorkspace('ws-source', SOURCE_PATH)
  const target = makeWorkspace('ws-target', TARGET_PATH)
  const registry = makeRegistry(source, target)
  const deps = depsFor({ root, transcript, events: EVENTS, registry, cache: undefined, failCreate: true })

  const result = await transferSession(deps, {
    sessionId: SESSION_ID,
    workspaceId: target.id,
    mode: 'move',
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'move-failed')
  // Nothing was filed, nothing was detached, and the original log is back.
  assert.deepEqual(target.calls, [])
  assert.deepEqual(source.calls, [])
  assert.match(await readFile(transcript, 'utf8'), /session-1234/)
  await rm(root, { recursive: true, force: true })
})

test('a move that finds an open turn restores the source instead of splitting it', async () => {
  const { root, transcript } = await makeSession()
  const source = makeWorkspace('ws-source', SOURCE_PATH)
  const target = makeWorkspace('ws-target', TARGET_PATH)
  const registry = makeRegistry(source, target)
  // The preflight sees a closed turn; the write lease then observes an
  // auto-wake that started another one.
  const deps = depsFor({
    root,
    transcript,
    events: EVENTS,
    writeEvents: [...EVENTS, { type: 'turn/start', seq: 3, time: 4, data: { turn: 2 } }],
    registry,
  })

  const result = await transferSession(deps, {
    sessionId: SESSION_ID,
    workspaceId: target.id,
    mode: 'move',
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'session-running')
  assert.deepEqual(target.calls, [])
  assert.match(await readFile(transcript, 'utf8'), /session-1234/)
  await rm(root, { recursive: true, force: true })
})

test('a copy still creates a distinct session id', async () => {
  const { root, transcript } = await makeSession()
  const source = makeWorkspace('ws-source', SOURCE_PATH)
  const target = makeWorkspace('ws-target', TARGET_PATH)
  const registry = makeRegistry(source, target)
  const deps = depsFor({ root, transcript, events: EVENTS, registry, cache: undefined })

  const result = await transferSession(deps, {
    sessionId: SESSION_ID,
    workspaceId: target.id,
    mode: 'copy',
  })

  assert.equal(result.ok, true, JSON.stringify(result))
  assert.notEqual(result.value.sessionId, SESSION_ID)
  assert.equal(result.value.mode, 'copy')
  assert.deepEqual(target.calls, [['attach', result.value.sessionId]])
  // A copy never touches the source.
  assert.deepEqual(source.calls, [])
  assert.match(await readFile(transcript, 'utf8'), /session-1234/)
  await rm(root, { recursive: true, force: true })
})
