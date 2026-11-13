// Unit tests for the detached-conversation bookkeeping.
//
// The helpers live inside client.js's module closure, so the cases slice the
// shipped source text and evaluate it in an isolated function.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8')

const start = clientSource.indexOf('    const DETACHED_KEY = ')
const end = clientSource.indexOf('    const readDetachedBeat = ')
assert.ok(start >= 0 && end > start, 'missing detached helper anchors')
const helpers = new Function(`${clientSource.slice(start, end)}
return { DETACHED_KEY, DETACHED_STALE_MS, detachedKeyOf, detachedSessionOf, detachedAlive }`)()

test('a mark is one key per conversation and round-trips', () => {
  const id = 'session-3f6d'
  const key = helpers.detachedKeyOf(id)
  assert.ok(key.startsWith(helpers.DETACHED_KEY))
  assert.equal(helpers.detachedSessionOf(key), id)
})

test('only our own keys name a conversation', () => {
  assert.equal(helpers.detachedSessionOf('original-version-enhancements.history.v1'), '')
  assert.equal(helpers.detachedSessionOf(`x${helpers.DETACHED_KEY}abc`), '')
  assert.equal(helpers.detachedSessionOf(undefined), '')
})

test('a heartbeat older than the window budget is treated as gone', () => {
  const now = 10_000_000
  assert.equal(helpers.detachedAlive(now - 1_000, now), true)
  assert.equal(helpers.detachedAlive(now - helpers.DETACHED_STALE_MS, now), true)
  assert.equal(helpers.detachedAlive(now - helpers.DETACHED_STALE_MS - 1, now), false)
})

test('a missing or malformed heartbeat is not alive', () => {
  const now = 10_000_000
  assert.equal(helpers.detachedAlive(0, now), false)
  assert.equal(helpers.detachedAlive(undefined, now), false)
  assert.equal(helpers.detachedAlive(Number.NaN, now), false)
  assert.equal(helpers.detachedAlive('123', now), false)
})

test('a clock skew that puts the heartbeat in the future keeps the window alive', () => {
  const now = 10_000_000
  assert.equal(helpers.detachedAlive(now + 5_000, now), true)
})
