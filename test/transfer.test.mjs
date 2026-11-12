// Regression tests for the session transfer host path.
//
// A `move` must keep the source session's identity: the old implementation
// cloned the log under a fresh UUID, so the conversation became a different
// session (its links and open view stopped matching). These tests run against
// the real filesystem for the storage quarantine and a small fake persistence
// backend for the log itself.

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
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

/** The same conversation as DSH actually stores it: the seed phase closed inline. */
const SEED_MARKED_EVENTS = [
  ...EVENTS,
  { type: 'session/end-seed', seq: 3, time: 4, data: {} },
  { type: 'turn/start', seq: 4, time: 5, data: { turn: 2 } },
  { type: 'turn/end', seq: 5, time: 6, data: { turn: 2, reason: { kind: 'completed' } } },
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
 * Fake JSONL persistence: `open` serves the source log, `create` writes a real
 * header file under a project directory (as the backend does) so a rollback can
 * locate and remove it, and `stat` reports the materialized copy.
 */
const makePersistence = ({ root, transcript, events, writeEvents, failCreate = false, failAppend = false, indexCreated = true, header = HEADER }) => {
  const state = { created: new Map(), openedWrite: false, closed: 0 }
  const persistence = {
    state,
    name: 'session-persistence-jsonl',
    async open(id, access) {
      if (access === 'write') state.openedWrite = true
      return {
        header,
        read: async () => ({ events: access === 'write' ? writeEvents ?? events : events }),
        close: async () => { state.closed += 1 },
      }
    },
    async resolveCurrentLog(id) {
      return state.created.get(id)?.location ?? transcript
    },
    async stat(id) {
      const created = state.created.get(id)
      if (created !== undefined && indexCreated) {
        return {
          header: created.header,
          eventCount: created.eventCount,
          sizeBytes: 10,
          location: { kind: 'jsonl', path: created.location },
        }
      }
      return id === SESSION_ID ? { header, location: { kind: 'jsonl', path: transcript } } : undefined
    },
    async list() {
      if (!indexCreated) return []
      return [...state.created.values()].map(entry => ({ header: entry.header }))
    },
    async create(meta) {
      if (failCreate) throw new Error('disk is full')
      const directory = join(root, 'target-project', meta.id)
      await mkdir(directory, { recursive: true })
      const location = join(directory, 'session.jsonl')
      await writeFile(location, `${JSON.stringify(meta)}\n`)
      const entry = { header: meta, eventCount: 0, events: [], location }
      state.created.set(meta.id, entry)
      return {
        header: meta,
        async append(batch) {
          if (failAppend) throw new Error('ENOSPC: no space left on device')
          await writeFile(location, batch.map(event => JSON.stringify(event)).join('\n'), { flag: 'a' })
          entry.eventCount += batch.length
          entry.events.push(...batch)
        },
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
const makeRegistry = (source, target, archivedSessionIds = []) => {
  const calls = { indexed: [], unarchived: [], unpinned: [] }
  return {
    calls,
    archivedSessionIds,
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

const depsFor = ({ root, transcript, events, registry, cache, failCreate, failAppend, writeEvents, agentHandles, indexCreated, header }) => ({
  workspaceRegistry: registry,
  sessionPersistence: makePersistence({ root, transcript, events, failCreate, failAppend, writeEvents, indexCreated, header }),
  sessionProjectionCache: cache,
  sessions: { get: () => undefined },
  agents: { get: () => undefined },
  agentHandles: agentHandles ?? {},
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
  // The undo receipt carries where the session came from, so the toast can
  // offer undo even when the client's workspace snapshot is stale.
  assert.deepEqual(result.value.source, { workspaceId: 'ws-source', cwd: SOURCE_PATH })

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

  // The cached projection follows the moved identity under the same id, with the
  // unseeded log's inherited cut left at zero so the cache accepts the identity.
  assert.equal(cold.length, 1)
  assert.equal(cold[0].meta.id, SESSION_ID)
  assert.equal(cold[0].meta.cwd, TARGET_PATH)
  assert.equal(cold[0].inherited, 0)

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
  // The registry's cached header/cwd is put back too: leaving the target path
  // there would filter the session out of the source workspace until a restart.
  assert.deepEqual(registry.calls.indexed.map(header => header.cwd), [SOURCE_PATH])
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

test('an archived session is refused before any storage work', async () => {
  const { root, transcript } = await makeSession()
  const source = makeWorkspace('ws-source', SOURCE_PATH)
  const target = makeWorkspace('ws-target', TARGET_PATH)
  const registry = makeRegistry(source, target, [SESSION_ID])
  const deps = depsFor({ root, transcript, events: EVENTS, registry })

  const result = await transferSession(deps, {
    sessionId: SESSION_ID,
    workspaceId: target.id,
    mode: 'move',
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'session-archived')
  // Refused before the write lease: another client's archive set cannot race a
  // silent re-file.
  assert.equal(deps.sessionPersistence.state.openedWrite, false)
  assert.deepEqual(source.calls, [])
  assert.deepEqual(target.calls, [])
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

test('a copy warms the projection with no inherited prefix for an unseeded log', async () => {
  const { root, transcript } = await makeSession()
  const source = makeWorkspace('ws-source', SOURCE_PATH)
  const target = makeWorkspace('ws-target', TARGET_PATH)
  const registry = makeRegistry(source, target)
  const cold = []
  const cache = { coldSnapshot: (meta, inherited, events) => { cold.push({ meta, inherited, events }) } }
  // A plain DSH log closes its own seed phase with this marker. It is NOT an
  // inherited prefix: the projection cache rejects an unseeded identity that
  // carries one, and the copy would then show up without a title until opened.
  const deps = depsFor({ root, transcript, events: SEED_MARKED_EVENTS, registry, cache })

  const result = await transferSession(deps, {
    sessionId: SESSION_ID,
    workspaceId: target.id,
    mode: 'copy',
  })

  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(cold.length, 1)
  assert.equal(cold[0].inherited, 0)
  assert.equal(cold[0].meta.isSeeded, false)
  assert.equal(cold[0].meta.cwd, TARGET_PATH)
  assert.equal(cold[0].events.length, SEED_MARKED_EVENTS.length)
  await rm(root, { recursive: true, force: true })
})

test('a copy of a seeded log keeps the inherited prefix it really has', async () => {
  const { root, transcript } = await makeSession()
  const source = makeWorkspace('ws-source', SOURCE_PATH)
  const target = makeWorkspace('ws-target', TARGET_PATH)
  const registry = makeRegistry(source, target)
  const cold = []
  const cache = { coldSnapshot: (meta, inherited, events) => { cold.push({ meta, inherited, events }) } }
  const deps = depsFor({
    root,
    transcript,
    events: SEED_MARKED_EVENTS,
    registry,
    cache,
    header: { ...HEADER, isSeeded: true },
  })

  const result = await transferSession(deps, {
    sessionId: SESSION_ID,
    workspaceId: target.id,
    mode: 'copy',
  })

  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(cold.length, 1)
  // The marker sits at seq 3, so the copy inherits those three events.
  assert.equal(cold[0].inherited, 3)
  assert.equal(cold[0].meta.isSeeded, true)
  await rm(root, { recursive: true, force: true })
})

test('a move that fails after create removes the half-written copy', async () => {
  const { root, transcript } = await makeSession()
  const source = makeWorkspace('ws-source', SOURCE_PATH)
  const target = makeWorkspace('ws-target', TARGET_PATH)
  const registry = makeRegistry(source, target)
  // create publishes a header; the following append fails (ENOSPC/EIO).
  const deps = depsFor({ root, transcript, events: EVENTS, registry, failAppend: true })

  const result = await transferSession(deps, {
    sessionId: SESSION_ID,
    workspaceId: target.id,
    mode: 'move',
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'move-failed')
  // The source is back where it was, and no second log for the same id was
  // left behind in the target project.
  assert.match(await readFile(transcript, 'utf8'), /session-1234/)
  await assert.rejects(stat(join(root, 'target-project', SESSION_ID)), error => error.code === 'ENOENT')
  assert.deepEqual(target.calls, [])
  // The still-existing source was not detached from its workspace.
  assert.deepEqual(source.calls, [])
  await rm(root, { recursive: true, force: true })
})

test('a move still clears a copy the backend has not indexed yet', async () => {
  const { root, transcript } = await makeSession()
  const source = makeWorkspace('ws-source', SOURCE_PATH)
  const target = makeWorkspace('ws-target', TARGET_PATH)
  const registry = makeRegistry(source, target)
  // create wrote the log, but `list`/`stat` do not see it yet (an interrupted
  // index). The removal falls back to the storage scan instead of leaving it.
  const deps = depsFor({
    root,
    transcript,
    events: EVENTS,
    registry,
    failAppend: true,
    indexCreated: false,
  })

  const result = await transferSession(deps, {
    sessionId: SESSION_ID,
    workspaceId: target.id,
    mode: 'move',
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'move-failed')
  assert.deepEqual(await readdir(join(root, 'target-project')), [])
  assert.match(await readFile(transcript, 'utf8'), /session-1234/)
  await rm(root, { recursive: true, force: true })
})

test('a copy that fails after create removes the half-written copy', async () => {
  const { root, transcript } = await makeSession()
  const source = makeWorkspace('ws-source', SOURCE_PATH)
  const target = makeWorkspace('ws-target', TARGET_PATH)
  const registry = makeRegistry(source, target)
  const deps = depsFor({ root, transcript, events: EVENTS, registry, failAppend: true })

  const result = await transferSession(deps, {
    sessionId: SESSION_ID,
    workspaceId: target.id,
    mode: 'copy',
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'copy-failed')
  assert.deepEqual(target.calls, [])
  assert.deepEqual(await readdir(join(root, 'target-project')), [])
  await rm(root, { recursive: true, force: true })
})

test('a move takes the deletion reservation for the whole operation', async () => {
  const { root, transcript } = await makeSession()
  const source = makeWorkspace('ws-source', SOURCE_PATH)
  const target = makeWorkspace('ws-target', TARGET_PATH)
  const registry = makeRegistry(source, target)
  const held = []
  const deps = depsFor({
    root,
    transcript,
    events: EVENTS,
    registry,
    agentHandles: {
      reserve(sessionId) {
        held.push(['reserve', sessionId])
        return () => held.push(['release', sessionId])
      },
    },
  })

  const result = await transferSession(deps, {
    sessionId: SESSION_ID,
    workspaceId: target.id,
    mode: 'move',
  })

  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(held, [['reserve', SESSION_ID], ['release', SESSION_ID]])
  await rm(root, { recursive: true, force: true })
})

test('a move is refused while a deletion owns the session', async () => {
  const { root, transcript } = await makeSession()
  const source = makeWorkspace('ws-source', SOURCE_PATH)
  const target = makeWorkspace('ws-target', TARGET_PATH)
  const registry = makeRegistry(source, target)
  const deps = depsFor({
    root,
    transcript,
    events: EVENTS,
    registry,
    // The delete path already holds the id's reservation.
    agentHandles: { reserve: () => undefined },
  })

  const result = await transferSession(deps, {
    sessionId: SESSION_ID,
    workspaceId: target.id,
    mode: 'move',
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'deletion-in-progress')
  // Refused before the write lease or any directory rename.
  assert.equal(deps.sessionPersistence.state.openedWrite, false)
  assert.deepEqual(target.calls, [])
  assert.match(await readFile(transcript, 'utf8'), /session-1234/)
  await rm(root, { recursive: true, force: true })
})
