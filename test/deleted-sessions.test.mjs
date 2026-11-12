// Regression tests for retained deletions: the undo trash behind "撤销" on a
// permanent deletion. They run against the real filesystem (the trash is a
// directory move, not a bookkeeping flag), with fake Workspace/persistence
// services standing in for the Host.

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const moduleUrl = new URL('../host/deleted-sessions.mjs', import.meta.url)
const {
  purgeRetainedSession,
  purgeStaleRetainedSessions,
  readRetainedState,
  restoreRetainedSession,
  retainDeletedSession,
} = await import(moduleUrl)

const SESSION_ID = 'session-12345678-1234-1234-1234-123456789abc'
const HEADER = {
  version: 4,
  id: SESSION_ID,
  createdAt: 1_700_000_000_000,
  cwd: 'C:/work/project',
  isSeeded: false,
}
const EVENTS = [
  { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
  { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
  { type: 'session/end-seed', seq: 2, time: 3, data: {} },
]

/** One deleted session's directory, as the delete path hands it over. */
const makeRemovedSession = async () => {
  const work = await mkdtemp(join(tmpdir(), 'ove-trash-'))
  const profileDir = join(work, 'profile')
  const projectDir = join(work, 'sessions', 'project')
  const sessionDirectory = join(projectDir, SESSION_ID)
  await mkdir(sessionDirectory, { recursive: true })
  await writeFile(join(sessionDirectory, 'session.jsonl'), `${JSON.stringify(HEADER)}\n`)
  return { work, profileDir, projectDir, sessionDirectory }
}

test('a retained deletion moves the directory into the trash and keeps its identity', async () => {
  const { work, profileDir, projectDir, sessionDirectory } = await makeRemovedSession()
  const retained = await retainDeletedSession({
    profileDir,
    sessionId: SESSION_ID,
    projectDir,
    name: SESSION_ID,
    sourceDirectory: sessionDirectory,
    header: HEADER,
  })

  assert.equal(typeof retained.token, 'string')
  await assert.rejects(stat(sessionDirectory), error => error.code === 'ENOENT')
  const state = await readRetainedState(profileDir)
  const entry = state.entries[retained.token]
  assert.equal(entry.sessionId, SESSION_ID)
  assert.equal(entry.projectDir, projectDir)
  assert.match(await readFile(join(entry.directory, 'session.jsonl'), 'utf8'), /session-1234/)
  await rm(work, { recursive: true, force: true })
})

test('undoing a retained deletion files the session again, cache included', async () => {
  const { work, profileDir, projectDir, sessionDirectory } = await makeRemovedSession()
  const retained = await retainDeletedSession({
    profileDir,
    sessionId: SESSION_ID,
    projectDir,
    name: SESSION_ID,
    sourceDirectory: sessionDirectory,
    header: HEADER,
    archived: true,
  })

  const calls = []
  const deps = {
    profileDir,
    workspaceRegistry: {
      indexHeader: async header => { calls.push(['index', header.id]) },
      resolveByPath: async path => ({ id: 'ws-1', attachSession: async id => { calls.push(['attach', path, id]) } }),
      archiveSession: async id => { calls.push(['archive', id]) },
    },
    sessionPersistence: {
      open: async () => ({
        header: HEADER,
        read: async () => ({ events: EVENTS }),
        close: async () => undefined,
      }),
    },
    sessionProjectionCache: {
      coldSnapshot: (meta, inherited, events) => { calls.push(['cold', meta.id, inherited, events.length]) },
    },
  }

  const result = await restoreRetainedSession(deps, { token: retained.token })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.value.sessionId, SESSION_ID)
  assert.equal(result.value.archived, true)
  // The log is back where the delete took it from.
  assert.match(await readFile(join(projectDir, SESSION_ID, 'session.jsonl'), 'utf8'), /session-1234/)
  // The Host is told about it again, in the order that makes it listable.
  assert.deepEqual(calls, [
    ['index', SESSION_ID],
    ['attach', HEADER.cwd, SESSION_ID],
    ['archive', SESSION_ID],
    // An unseeded log never inherits a prefix, even with the seed marker present.
    ['cold', SESSION_ID, 0, EVENTS.length],
  ])
  // The entry is spent: the same token cannot restore twice.
  const again = await restoreRetainedSession(deps, { token: retained.token })
  assert.equal(again.ok, false)
  assert.equal(again.error.code, 'undo-expired')
  await rm(work, { recursive: true, force: true })
})

test('purging a retained deletion destroys the storage it kept', async () => {
  const { work, profileDir, projectDir, sessionDirectory } = await makeRemovedSession()
  const retained = await retainDeletedSession({
    profileDir,
    sessionId: SESSION_ID,
    projectDir,
    name: SESSION_ID,
    sourceDirectory: sessionDirectory,
    header: HEADER,
  })
  const entry = (await readRetainedState(profileDir)).entries[retained.token]

  const purged = await purgeRetainedSession({ profileDir }, { token: retained.token })
  assert.equal(purged.ok, true)
  assert.equal(purged.value.purged, true)
  await assert.rejects(stat(entry.directory), error => error.code === 'ENOENT')
  assert.deepEqual((await readRetainedState(profileDir)).entries, {})
  const restore = await restoreRetainedSession({ profileDir }, { token: retained.token })
  assert.equal(restore.ok, false)
  assert.equal(restore.error.code, 'undo-expired')
  await rm(work, { recursive: true, force: true })
})

test('stale trash entries are dropped on the next start, fresh ones kept', async () => {
  const { work, profileDir, projectDir, sessionDirectory } = await makeRemovedSession()
  const old = await retainDeletedSession({
    profileDir,
    sessionId: SESSION_ID,
    projectDir,
    name: SESSION_ID,
    sourceDirectory: sessionDirectory,
    header: HEADER,
    now: 1_000,
  })
  await mkdir(join(projectDir, SESSION_ID), { recursive: true })
  await writeFile(join(projectDir, SESSION_ID, 'session.jsonl'), `${JSON.stringify(HEADER)}\n`)
  const fresh = await retainDeletedSession({
    profileDir,
    sessionId: SESSION_ID,
    projectDir,
    name: SESSION_ID,
    sourceDirectory: join(projectDir, SESSION_ID),
    header: HEADER,
    now: 10_000,
  })

  const dropped = await purgeStaleRetainedSessions({ profileDir, maxAgeMs: 5_000, now: 12_000 })
  assert.equal(dropped, 1)
  const entries = (await readRetainedState(profileDir)).entries
  assert.deepEqual(Object.keys(entries), [fresh.token])
  assert.equal(entries[old.token], undefined)
  await rm(work, { recursive: true, force: true })
})
