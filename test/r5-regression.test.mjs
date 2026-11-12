// Round-5 regression tests.
//
// These are executable cases for the P1/P2 findings of the fourth report, plus
// the stress cases the fifth round asked for. They are written against the
// current host code (v1.14.1 / d4ae5cb) and do NOT modify it: a case that fails
// is the proof the bug is still there; a case that passes means the finding no
// longer reproduces and has to be retracted.

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const deletedUrl = new URL('../host/deleted-sessions.mjs', import.meta.url)
const deleteUrl = new URL('../host/delete-session.mjs', import.meta.url)
const automationUrl = new URL('../host/automation.mjs', import.meta.url)

const {
  readRetainedState, retainDeletedSession, retainedStateFile, retainedRoot,
} = await import(deletedUrl)
const { deleteSessionSafely } = await import(deleteUrl)
const { readAutomationState, writeAutomationState } = await import(automationUrl)

const SESSION_ID = 'session-r5-0000-0000-0000-000000000001'
const HEADER = { version: 4, id: SESSION_ID, createdAt: 1_700_000_000_000, cwd: 'C:/work/project', isSeeded: false }

/** Lay out one session the way the JSONL backend does. */
const makeSession = async () => {
  const root = await mkdtemp(join(tmpdir(), 'r5-del-'))
  const sessionDirectory = join(root, 'project', SESSION_ID)
  await mkdir(sessionDirectory, { recursive: true })
  const transcript = join(sessionDirectory, 'session.jsonl')
  await writeFile(transcript, `${JSON.stringify(HEADER)}\n`)
  return { root, sessionDirectory, transcript }
}

const makePersistence = ({ transcript }) => ({
  name: 'session-persistence-jsonl',
  open: async () => ({ header: HEADER, close: async () => {} }),
  stat: async id => (id === SESSION_ID
    ? { header: HEADER, revision: 'rev-1', formatStatus: 'current', location: { kind: 'jsonl', path: transcript } }
    : undefined),
  list: async () => [{ header: HEADER, formatStatus: 'current', location: { kind: 'jsonl', path: transcript } }],
  resolveCurrentLog: async () => transcript,
})

const emptyRegistry = () => ({ get: () => undefined })

// ---------------------------------------------------------------------------
// R1 (4th report P2-1): a retain whose index write fails must not leave the
// session in the trash unindexed. The fix rolls the directory back and throws.
// Expected now: PASS (finding retracted).
// ---------------------------------------------------------------------------
test('R1 retain index-write failure rolls the directory back', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'r5-profile-'))
  const source = join(profile, 'project', SESSION_ID)
  await mkdir(source, { recursive: true })
  await writeFile(join(source, 'session.jsonl'), '{"a":1}\n')
  // Make the index path a directory so the atomic rename must fail.
  await mkdir(retainedStateFile(profile), { recursive: true })

  await assert.rejects(() => retainDeletedSession({
    profileDir: profile,
    sessionId: SESSION_ID,
    projectDir: join(profile, 'project'),
    name: SESSION_ID,
    sourceDirectory: source,
    header: HEADER,
  }))

  const restored = await stat(source).then(() => true, () => false)
  const trash = await stat(retainedRoot(profile)).then(() => true, () => false)
  assert.equal(restored, true, 'the removed directory must be moved back when the index cannot be written')
  if (trash) {
    const state = await readRetainedState(profile, () => {})
    assert.equal(Object.keys(state.entries).length, 0, 'a failed retain must not leave an index entry')
  }
})

// ---------------------------------------------------------------------------
// R2 (4th report P2-1, caller side): when retain reports an orphaned directory,
// the deletion must NOT answer "ok". Expected now: PASS (retracted).
// ---------------------------------------------------------------------------
test('R2 an orphaned retain is reported as a failed deletion', async () => {
  const { root, transcript } = await makeSession()
  const result = await deleteSessionSafely({
    sessions: emptyRegistry(),
    agents: emptyRegistry(),
    agentHandles: { reserve: () => () => {} },
    sessionPersistence: makePersistence({ transcript }),
  }, {
    sessionRoot: root,
    sessionId: SESSION_ID,
    retain: () => {
      const error = new Error('index write failed')
      error.retained = 'orphaned'
      error.trashDirectory = 'C:/trash/leftover'
      throw error
    },
  })
  assert.equal(result.ok, false, 'the Host must not confirm a deletion it could not file for undo')
  assert.equal(result.error.code, 'storage-partial')
})

// ---------------------------------------------------------------------------
// R3 (4th report P2-2): a truncated automation sidecar must recover from .bak
// instead of silently resetting every map. Expected now: PASS (retracted).
// ---------------------------------------------------------------------------
test('R3 a truncated sidecar recovers from the .bak generation', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'r5-auto-'))
  const file = join(profile, 'original-version-enhancements.automation.json')
  const state = {
    version: 1,
    autoClean: { 'task-1': true, 'task-2': true },
    copies: { 'task-1': ['session-copy-1'] },
    ephemeral: { 'clone-1': { sourceId: 'task-1', createdAt: '2026-11-12T00:00:00.000Z' } },
  }
  assert.equal(writeAutomationState(file, state, () => {}), true)
  assert.equal(writeAutomationState(file, state, () => {}), true) // creates .bak
  await writeFile(file, JSON.stringify(state).slice(0, 40)) // crash mid-write

  const read = readAutomationState(file, () => {})
  assert.deepEqual(read.autoClean, state.autoClean)
  assert.deepEqual(read.copies, state.copies)
  assert.deepEqual(read.ephemeral, state.ephemeral)
})

// ---------------------------------------------------------------------------
// R4 (new, P3): the .bak recovery only runs when JSON.parse THROWS. A sidecar
// that is valid JSON but the wrong shape (`null`, `[]`, a string) is accepted as
// "nothing to read" and the good backup is ignored, so every map still resets.
// ---------------------------------------------------------------------------
test('R4 a wrong-shape sidecar still resets every map despite a good backup', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'r5-shape-'))
  const file = join(profile, 'original-version-enhancements.automation.json')
  const state = {
    version: 1,
    autoClean: { 'task-1': true },
    copies: { 'task-1': ['session-copy-1'] },
    ephemeral: {},
  }
  assert.equal(writeAutomationState(file, state, () => {}), true)
  assert.equal(writeAutomationState(file, state, () => {}), true) // .bak holds the good state
  await writeFile(file, 'null', 'utf8')

  const read = readAutomationState(file, () => {})
  assert.deepEqual(read.autoClean, state.autoClean, 'a valid-JSON null sidecar must fall back to .bak')
})

// ---------------------------------------------------------------------------
// Stress 1 (fifth round): ten concurrent permanent deletes of one id. The
// reservation must let exactly one run; the rest must be refused, not race.
// ---------------------------------------------------------------------------
test('S1 ten concurrent deletes of one session serialise on the reservation', async () => {
  const { root, transcript } = await makeSession()
  const base = {
    sessions: emptyRegistry(),
    agents: emptyRegistry(),
    sessionPersistence: makePersistence({ transcript }),
  }
  // Every call gets its own reservation hook factory but the SAME shared set.
  const held = new Set()
  const reserve = (id) => {
    if (held.has(id)) return undefined
    held.add(id)
    let active = true
    return () => { if (active) { active = false; held.delete(id) } }
  }
  const results = await Promise.all(Array.from({ length: 10 }, () => deleteSessionSafely(
    { ...base, agentHandles: { reserve } },
    { sessionRoot: root, sessionId: SESSION_ID },
  )))
  const refused = results.filter(r => r.ok === false && r.error.code === 'deletion-in-progress')
  assert.equal(refused.length, 9, `expected 9 refusals, got ${JSON.stringify(results.map(r => r.error?.code ?? 'ok'))}`)
  assert.equal(results.filter(r => r.ok).length, 1)
})

// ---------------------------------------------------------------------------
// Stress 2 (fifth round): a sidecar truncated to half and read at restart must
// not lose the maps (same guarantee as R3, from a restart-shaped call).
// ---------------------------------------------------------------------------
test('S2 a half-written sidecar is readable again after a restart', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'r5-restart-'))
  const file = join(profile, 'original-version-enhancements.automation.json')
  const state = { version: 1, autoClean: { a: true, b: true }, copies: { a: ['s1'] }, ephemeral: {} }
  writeAutomationState(file, state, () => {})
  writeAutomationState(file, state, () => {})
  const raw = await readFile(file, 'utf8')
  await writeFile(file, raw.slice(0, Math.floor(raw.length / 2)))
  const read = readAutomationState(file, () => {})
  assert.deepEqual(read.autoClean, state.autoClean)
  assert.deepEqual(read.copies, state.copies)
})

// ---------------------------------------------------------------------------
// R5 (new, P3): the backup is taken from whatever the main file holds BEFORE
// the new generation is durable. Recovering from .bak and then failing the very
// next save copies the corrupt main over the only good backup, so the next read
// falls back to nothing.
// ---------------------------------------------------------------------------
test('R5 a failed save after recovery destroys the only good backup', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'r5-bak-'))
  const file = join(profile, 'original-version-enhancements.automation.json')
  const state = { version: 1, autoClean: { keep: true }, copies: { keep: ['s1'] }, ephemeral: {} }
  writeAutomationState(file, state, () => {})
  writeAutomationState(file, state, () => {}) // .bak = good generation
  const raw = await readFile(file, 'utf8')
  await writeFile(file, raw.slice(0, 10), 'utf8') // main is corrupt

  const recovered = readAutomationState(file, () => {})
  assert.deepEqual(recovered.autoClean, state.autoClean, 'precondition: the .bak recovery works')

  // Force the next save to fail AFTER the backup copy: `.tmp` is a directory.
  await mkdir(`${file}.tmp`, { recursive: true })
  const saved = writeAutomationState(file, recovered, () => {})
  assert.equal(saved, false, 'precondition: the save fails')

  const again = readAutomationState(file, () => {})
  assert.deepEqual(again.autoClean, state.autoClean, 'the good .bak must survive a failed save')
})
