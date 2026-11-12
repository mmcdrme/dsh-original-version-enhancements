// Regression tests for the permanent-deletion host path.
//
// They run against the real filesystem with a small fake persistence backend,
// so the safety checks (identity validation, quarantine, forced removal) are
// exercised end to end. The fake host services mirror the DSH 0.2.x shape:
// `agentHandles` is installed over an agent registry that keeps a live Agent
// until its lifecycle handle is disposed.

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

const moduleUrl = new URL('../host/delete-session.mjs', import.meta.url)
const {
  deleteSessionSafely,
  installAgentHandleTracker,
} = await import(moduleUrl)

const SESSION_ID = 'session-12345678-1234-1234-1234-123456789abc'
const HEADER = {
  version: 4,
  id: SESSION_ID,
  createdAt: 1_700_000_000_000,
  cwd: 'C:/work/project',
  isSeeded: false,
}

/** Create one session directory exactly as the JSONL backend lays it out. */
const makeSession = async () => {
  const root = await mkdtemp(join(tmpdir(), 'ove-delete-'))
  const sessionDirectory = join(root, 'project', SESSION_ID)
  const transcript = join(sessionDirectory, 'session.jsonl')
  await mkdir(sessionDirectory, { recursive: true })
  await writeFile(transcript, `${JSON.stringify(HEADER)}\n`)
  return { root, sessionDirectory, transcript }
}

/** A registry keyed by id, matching `agents.get`/`sessions.get`. */
const registry = () => {
  const entries = new Map()
  return {
    entries,
    get: id => entries.get(id),
    set: (id, value) => entries.set(id, value),
    delete: id => entries.delete(id),
  }
}

/**
 * Fake host registries plus the tracker, wired the way DSH wires them: the
 * factory methods exist before the tracker is installed, and `resume` returns
 * the lifecycle handle the tracker must retain.
 */
const makeHost = () => {
  const agents = registry()
  const sessions = registry()
  const calls = []
  let nextHandle
  agents.create = async () => nextHandle
  agents.resume = async () => nextHandle
  agents.enter = () => undefined
  sessions.enter = () => undefined
  const agentHandles = installAgentHandleTracker(agents, sessions)
  const host = {
    agents,
    sessions,
    agentHandles,
    calls,
    /** Publish a live Agent; the caller supplies its dispose behaviour. */
    live() {
      const agent = { id: SESSION_ID }
      agents.set(SESSION_ID, agent)
      nextHandle = {
        agent,
        dispose: async () => {
          calls.push('dispose')
          agents.delete(SESSION_ID)
        },
      }
      return nextHandle
    },
    /** Resume the session so the tracker retains `nextHandle`. */
    async resume() {
      await agents.resume({ resumeSessionId: SESSION_ID })
    },
  }
  return host
}

/**
 * Build the fake persistence backend. `state.opened` records whether the write
 * lease was acquired, which tells us whether the lifecycle checks ran first.
 */
const makePersistence = ({ transcript, formatStatus = 'current', resolveCurrentLog, gate }) => {
  const state = { opened: false, closed: false }
  return {
    state,
    name: 'session-persistence-jsonl',
    open: async () => {
      if (gate !== undefined) await gate
      state.opened = true
      return {
        header: HEADER,
        close: async () => { state.closed = true },
      }
    },
    stat: async id => (id === SESSION_ID
      ? {
          header: HEADER,
          revision: 'rev-1',
          formatStatus,
          location: { kind: 'jsonl', path: transcript },
        }
      : undefined),
    list: async () => [{ header: HEADER, formatStatus, location: { kind: 'jsonl', path: transcript } }],
    resolveCurrentLog: async id => (id !== SESSION_ID
      ? undefined
      : resolveCurrentLog === undefined ? transcript : resolveCurrentLog(id)),
  }
}

const depsFor = (host, persistence) => ({
  sessions: host.sessions,
  agents: host.agents,
  agentHandles: host.agentHandles,
  sessionPersistence: persistence,
})

test('a tracked live session is stopped and its storage removed', async () => {
  const { root, sessionDirectory, transcript } = await makeSession()
  const host = makeHost()
  host.live()
  await host.resume()
  const persistence = makePersistence({ transcript })

  const result = await deleteSessionSafely(depsFor(host, persistence), {
    sessionRoot: root,
    sessionId: SESSION_ID,
  })

  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(host.calls, ['dispose'])
  assert.equal(host.agents.get(SESSION_ID), undefined)
  assert.equal(persistence.state.opened, true)
  assert.equal(persistence.state.closed, true)
  await assert.rejects(readFile(transcript, 'utf8'))
  await rm(sessionDirectory, { recursive: true, force: true })
  await rm(root, { recursive: true, force: true })
})

test('a retained deletion hands the validated directory to the undo hook', async () => {
  const { root, sessionDirectory, transcript } = await makeSession()
  const host = makeHost()
  const persistence = makePersistence({ transcript })
  const trash = join(root, 'trash')
  const seen = []

  const result = await deleteSessionSafely(depsFor(host, persistence), {
    sessionRoot: root,
    sessionId: SESSION_ID,
    retain: async (info) => {
      seen.push({ sessionId: info.sessionId, projectDir: info.projectDir, name: info.name, header: info.header })
      await mkdir(trash, { recursive: true })
      await rename(info.directory, join(trash, info.name))
      return { token: 'token-1' }
    },
  })

  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(result.value, { deleted: true, retained: { token: 'token-1' } })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].sessionId, SESSION_ID)
  assert.equal(seen[0].projectDir, join(root, 'project'))
  assert.equal(seen[0].id, undefined)
  assert.equal(seen[0].name, SESSION_ID)
  assert.equal(seen[0].header.id, SESSION_ID)
  // Nothing was destroyed: the transcript moved into the undo trash instead of
  // being unlinked, which is what makes "撤销" possible.
  assert.match(await readFile(join(trash, SESSION_ID, 'session.jsonl'), 'utf8'), /session-1234/)
  await assert.rejects(stat(sessionDirectory), error => error.code === 'ENOENT')
  await rm(root, { recursive: true, force: true })
})

test('a retain that fails is reported as partial, never as a finished delete', async () => {
  const { root, sessionDirectory, transcript } = await makeSession()
  const host = makeHost()
  const persistence = makePersistence({ transcript })
  const stagingOf = async () => {
    const found = []
    for (const entry of await readdir(dirname(root), { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('.dsh-session-delete-')) continue
      const inner = await readdir(join(dirname(root), entry.name)).catch(() => [])
      if (inner.includes(SESSION_ID)) found.push(entry.name)
    }
    return found
  }
  const before = new Set(await stagingOf())

  const result = await deleteSessionSafely(depsFor(host, persistence), {
    sessionRoot: root,
    sessionId: SESSION_ID,
    retain: async () => { throw new Error('the trash index is not writable') },
  })

  // The directory left the persistence root but never reached the undo trash, so
  // the deletion is not confirmed: the human must not be told it succeeded.
  assert.equal(result.ok, false, JSON.stringify(result))
  assert.equal(result.error.code, 'storage-partial')
  assert.match(result.error.message, /撤销回收区/)
  await assert.rejects(stat(sessionDirectory), error => error.code === 'ENOENT')
  // The quarantine still holds the only copy of the log; it lives next to the
  // session root, which is where the delete path stages it.
  const staged = (await stagingOf()).filter(name => !before.has(name))
  assert.equal(staged.length, 1)
  await rm(root, { recursive: true, force: true })
})

test('a live session without a tracked handle is refused before any storage work', async () => {
  const { root, sessionDirectory } = await makeSession()
  const host = makeHost()
  host.live()
  const persistence = makePersistence({ transcript: join(sessionDirectory, 'session.jsonl') })

  const result = await deleteSessionSafely(depsFor(host, persistence), {
    sessionRoot: root,
    sessionId: SESSION_ID,
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'lifecycle-unavailable')
  assert.match(result.error.message, /强制删除/)
  assert.equal(persistence.state.opened, false)
  assert.match(await readFile(join(sessionDirectory, 'session.jsonl'), 'utf8'), /session-1234/)
  await rm(root, { recursive: true, force: true })
})

test('a handle retained before a plugin reload still unloads the session', async () => {
  const host = makeHost()
  host.live()
  await host.resume()
  const firstResume = host.agents.resume

  // A reloaded plugin generation shares the process-wide tracker state.
  const reloaded = await import(`${moduleUrl.href}?generation=2`)
  const after = reloaded.installAgentHandleTracker(host.agents, host.sessions)

  // The registry must not be wrapped twice by the reloaded generation.
  assert.equal(host.agents.resume, firstResume)
  assert.equal(await after.dispose(SESSION_ID), true)
  assert.deepEqual(host.calls, ['dispose'])
  assert.equal(host.agents.get(SESSION_ID), undefined)
  // The previous generation observes the same shared state.
  assert.equal(await host.agentHandles.dispose(SESSION_ID), false)
})

test('a session store that trails the agent registry is still deleted', async () => {
  const { root, transcript } = await makeSession()
  const host = makeHost()
  host.live()
  await host.resume()
  // The session store keeps the entry for a couple of polls after the Agent
  // has been detached; the deletion must wait instead of refusing.
  host.sessions.set(SESSION_ID, { header: HEADER })
  let polls = 0
  const stored = host.sessions.entries.get(SESSION_ID)
  host.sessions.get = (id) => {
    if (id !== SESSION_ID) return undefined
    polls += 1
    if (polls > 2) {
      host.sessions.entries.delete(SESSION_ID)
      return undefined
    }
    return stored
  }
  const persistence = makePersistence({ transcript })

  const result = await deleteSessionSafely(depsFor(host, persistence), {
    sessionRoot: root,
    sessionId: SESSION_ID,
  })

  assert.equal(result.ok, true, JSON.stringify(result))
  assert.ok(polls >= 2)
  await assert.rejects(readFile(transcript, 'utf8'))
  await rm(root, { recursive: true, force: true })
})

test('force deletion locates the artifact from the observed snapshot', async () => {
  const { root, sessionDirectory } = await makeSession()
  const host = makeHost()
  host.live()
  const persistence = makePersistence({
    transcript: join(sessionDirectory, 'session.jsonl'),
    // A historical generation has no current log path.
    resolveCurrentLog: () => undefined,
  })

  const result = await deleteSessionSafely(depsFor(host, persistence), {
    sessionRoot: root,
    sessionId: SESSION_ID,
    force: true,
  })

  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(persistence.state.opened, false)
  await assert.rejects(readFile(sessionDirectory, 'utf8'))
  await rm(root, { recursive: true, force: true })
})

test('a historical storage format is removed without being opened for write', async () => {
  const { root, sessionDirectory } = await makeSession()
  const host = makeHost()
  const persistence = makePersistence({
    transcript: join(sessionDirectory, 'session.jsonl'),
    formatStatus: 'migration-required',
  })

  const result = await deleteSessionSafely(depsFor(host, persistence), {
    sessionRoot: root,
    sessionId: SESSION_ID,
  })

  assert.equal(result.ok, true, JSON.stringify(result))
  // Opening the log for write would publish a migration of a file that is about
  // to be deleted, so the artifact is located without the write lease.
  assert.equal(persistence.state.opened, false)
  await assert.rejects(readFile(sessionDirectory, 'utf8'))
  await rm(root, { recursive: true, force: true })
})

test('an unreadable log is deleted instead of being stuck forever', async () => {
  const { root, sessionDirectory } = await makeSession()
  const host = makeHost()
  const persistence = makePersistence({ transcript: join(sessionDirectory, 'session.jsonl') })
  // The log is corrupt: opening it for write fails the way the JSONL backend
  // reports a format violation, while the session is still listed.
  persistence.open = async () => {
    throw new Error('stored log is corrupt: SessionFormatError')
  }

  const result = await deleteSessionSafely(depsFor(host, persistence), {
    sessionRoot: root,
    sessionId: SESSION_ID,
  })

  assert.equal(result.ok, true, JSON.stringify(result))
  await assert.rejects(readFile(sessionDirectory, 'utf8'))
  await rm(root, { recursive: true, force: true })
})

test('concurrent deletions of one session are serialized', async () => {
  const { root } = await makeSession()
  const host = makeHost()
  let release
  const gate = new Promise(resolveGate => { release = resolveGate })
  const persistence = makePersistence({
    transcript: join(root, 'project', SESSION_ID, 'session.jsonl'),
    gate,
  })

  const first = deleteSessionSafely(depsFor(host, persistence), {
    sessionRoot: root,
    sessionId: SESSION_ID,
  })
  // Let the first request take its reservation.
  await new Promise(resolveTick => setTimeout(resolveTick, 20))
  const second = await deleteSessionSafely(depsFor(host, persistence), {
    sessionRoot: root,
    sessionId: SESSION_ID,
  })

  assert.equal(second.ok, false)
  assert.equal(second.error.code, 'deletion-in-progress')
  release()
  const result = await first
  assert.equal(result.ok, true, JSON.stringify(result))
  await rm(root, { recursive: true, force: true })
})

test('the tracker refuses to wrap a registry twice', () => {
  const host = makeHost()
  const wrapped = host.agents.resume
  installAgentHandleTracker(host.agents, host.sessions)
  assert.equal(host.agents.resume, wrapped)
})

/**
 * Persistence for a session the backend does not know at all: the interrupted
 * write left an empty session directory and no header anywhere.
 */
const makePhantomPersistence = () => ({
  name: 'session-persistence-jsonl',
  open: async () => {
    throw new Error(`session '${SESSION_ID}' not found`)
  },
  stat: async () => undefined,
  list: async () => [],
  resolveCurrentLog: async () => {
    throw new Error(`session '${SESSION_ID}' not found`)
  },
})

test('a session whose storage is an empty shell is removable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ove-delete-'))
  const sessionDirectory = join(root, 'project', SESSION_ID)
  await mkdir(sessionDirectory, { recursive: true })
  const host = makeHost()

  const result = await deleteSessionSafely(depsFor(host, makePhantomPersistence()), {
    sessionRoot: root,
    sessionId: SESSION_ID,
  })

  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.value.phantom, true)
  await assert.rejects(stat(sessionDirectory), error => error.code === 'ENOENT')
  await rm(root, { recursive: true, force: true })
})

test('every empty shell for one id is removed, not just the first', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ove-delete-'))
  const first = join(root, 'project-a', SESSION_ID)
  const second = join(root, 'project-b', SESSION_ID)
  await mkdir(first, { recursive: true })
  await mkdir(second, { recursive: true })
  const host = makeHost()

  const result = await deleteSessionSafely(depsFor(host, makePhantomPersistence()), {
    sessionRoot: root,
    sessionId: SESSION_ID,
  })

  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.value.phantom, true)
  await assert.rejects(stat(first), error => error.code === 'ENOENT')
  await assert.rejects(stat(second), error => error.code === 'ENOENT')
  await rm(root, { recursive: true, force: true })
})

test('a listed session whose log disappeared is removable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ove-delete-'))
  const sessionDirectory = join(root, 'project', SESSION_ID)
  const transcript = join(sessionDirectory, 'session.jsonl')
  await mkdir(sessionDirectory, { recursive: true })
  const host = makeHost()
  // The header outlives its transcript: the backend still lists the session but
  // the file itself is gone, so no read or write lease can ever succeed.
  const persistence = makePersistence({ transcript })

  const result = await deleteSessionSafely(depsFor(host, persistence), {
    sessionRoot: root,
    sessionId: SESSION_ID,
  })

  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.value.phantom, true)
  await assert.rejects(stat(sessionDirectory), error => error.code === 'ENOENT')
  await rm(root, { recursive: true, force: true })
})

/** A Workspace entity that records the accounting writes the deletion performs. */
const makeWorkspace = () => {
  const calls = []
  return {
    calls,
    id: 'ws-1',
    path: 'C:/work/project',
    async detachSession(sessionId) { calls.push(['detach', sessionId]) },
  }
}

/** The projection-cache table surface the deletion clears one record through. */
const makeProjectionTable = () => {
  const deleted = []
  return {
    deleted,
    async delete(sessionId) { deleted.push(sessionId) },
    async deleteMany() { return 0 },
    keys: () => [][Symbol.iterator](),
  }
}

test('a deletion drops the workspace accounting and cached projection', async () => {
  const { root, transcript } = await makeSession()
  const host = makeHost()
  const persistence = makePersistence({ transcript })
  const workspace = makeWorkspace()
  const table = makeProjectionTable()
  const registryCalls = []
  const registry = {
    list: () => [workspace],
    unarchiveSession: async (id) => { registryCalls.push(['unarchive', id]) },
    unpinSession: async (id) => { registryCalls.push(['unpin', id]) },
  }

  const result = await deleteSessionSafely({
    ...depsFor(host, persistence),
    workspaceRegistry: registry,
    sessionProjectionCache: { table },
  }, {
    sessionRoot: root,
    sessionId: SESSION_ID,
  })

  assert.equal(result.ok, true, JSON.stringify(result))
  // No id the registry still accounts may outlive its transcript, otherwise the
  // sidebar keeps a ghost conversation that cannot open.
  assert.deepEqual(workspace.calls, [['detach', SESSION_ID]])
  assert.deepEqual(registryCalls, [['unarchive', SESSION_ID], ['unpin', SESSION_ID]])
  assert.deepEqual(table.deleted, [SESSION_ID])
  await rm(root, { recursive: true, force: true })
})

test('a refused deletion leaves the workspace accounting untouched', async () => {
  const { root, sessionDirectory } = await makeSession()
  const host = makeHost()
  host.live()
  const workspace = makeWorkspace()
  const table = makeProjectionTable()
  const registry = {
    list: () => [workspace],
    unarchiveSession: async () => {},
    unpinSession: async () => {},
  }

  const result = await deleteSessionSafely({
    ...depsFor(host, makePersistence({ transcript: join(sessionDirectory, 'session.jsonl') })),
    workspaceRegistry: registry,
    sessionProjectionCache: { table },
  }, {
    sessionRoot: root,
    sessionId: SESSION_ID,
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'lifecycle-unavailable')
  assert.deepEqual(workspace.calls, [])
  assert.deepEqual(table.deleted, [])
  await rm(root, { recursive: true, force: true })
})
