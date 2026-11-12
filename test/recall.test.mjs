// Unit tests for the composer's sent-message history.
//
// The helpers live inside client.js's module closure (they are shared by the
// settings page and the composer bridge), so these cases slice the shipped
// source text and evaluate it in an isolated function — the behaviour under
// test is the code in the repository, not a copy of it.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8')

const slice = (startAnchor, endAnchor) => {
  const start = clientSource.indexOf(startAnchor)
  const end = clientSource.indexOf(endAnchor)
  assert.ok(start >= 0 && end > start, `missing anchors: ${startAnchor} / ${endAnchor}`)
  return clientSource.slice(start, end)
}

const keys = new Function(`${slice('    const HISTORY_LIMIT_MAX = ', '    let recallState = readRecall();')}
return { clampHistoryLimit, comboOfEvent, matchesCombo, comboLabel, keyOfCode, DEFAULT_RECALL, HISTORY_LIMIT_MAX }`)()

const { nextHistory } = new Function(`${slice('    const HISTORY_LIMIT_MAX = ', '    let recallState = readRecall();')}
${slice('    const nextHistory = ', '    let historySnapshot = readHistory();')}
return { nextHistory }`)()

/** A minimal KeyboardEvent stand-in. */
const stroke = (key, modifiers = {}, code = '') => ({
  key,
  code,
  ctrlKey: modifiers.ctrl === true,
  altKey: modifiers.alt === true,
  shiftKey: modifiers.shift === true,
  metaKey: modifiers.meta === true,
})

test('the defaults are Alt+P upward, Alt+B downward and 100 entries', () => {
  assert.deepEqual(keys.DEFAULT_RECALL, { prev: 'alt+p', next: 'alt+b', max: 100, perSession: false })
  assert.equal(keys.HISTORY_LIMIT_MAX, 100)
})

test('an unmodified stroke is never a binding', () => {
  assert.equal(keys.comboOfEvent(stroke('p')), undefined)
  assert.equal(keys.comboOfEvent(stroke('P', { shift: true })), 'shift+p')
  assert.equal(keys.comboOfEvent(stroke('Alt', { alt: true })), undefined)
  assert.equal(keys.comboOfEvent(stroke('Control', { ctrl: true })), undefined)
})

test('modifiers are recorded in a stable order', () => {
  assert.equal(keys.comboOfEvent(stroke('p', { alt: true })), 'alt+p')
  assert.equal(keys.comboOfEvent(stroke('P', { shift: true, ctrl: true, alt: true })), 'ctrl+alt+shift+p')
})

test('the binding matches the same physical key even when Alt composes another character', () => {
  assert.equal(keys.matchesCombo('alt+p', stroke('p', { alt: true })), true)
  assert.equal(keys.matchesCombo('alt+p', stroke('π', { alt: true }, 'KeyP')), true)
  assert.equal(keys.matchesCombo('alt+b', stroke('p', { alt: true })), false)
  assert.equal(keys.matchesCombo('alt+p', stroke('p')), false)
  assert.equal(keys.matchesCombo('alt+p', stroke('p', { alt: true, shift: true })), false)
  assert.equal(keys.matchesCombo('', stroke('p', { alt: true })), false)
})

test('a binding is shown in a readable form', () => {
  assert.equal(keys.comboLabel('alt+p'), 'Alt + P')
  assert.equal(keys.comboLabel('ctrl+alt+arrowup'), 'Ctrl + Alt + ↑')
  assert.equal(keys.comboLabel(''), '')
})

test('the history limit stays inside 1..100', () => {
  assert.equal(keys.clampHistoryLimit('0'), 1)
  assert.equal(keys.clampHistoryLimit(-5), 1)
  assert.equal(keys.clampHistoryLimit(500), 100)
  assert.equal(keys.clampHistoryLimit('abc'), 100)
  assert.equal(keys.clampHistoryLimit(3.4), 3)
  assert.equal(keys.clampHistoryLimit(undefined), 100)
})

test('a new submission is remembered newest first', () => {
  assert.deepEqual(nextHistory([], 'first', 20), ['first'])
  assert.deepEqual(nextHistory(['first'], 'second', 20), ['second', 'first'])
})

test('consecutive duplicates collapse and blank submissions are ignored', () => {
  assert.deepEqual(nextHistory(['a', 'b'], 'a', 20), ['a', 'b'])
  assert.deepEqual(nextHistory(['a', 'b'], 'a', 20).length, 2)
  assert.deepEqual(nextHistory(['a'], '   ', 20), ['a'])
  assert.deepEqual(nextHistory(['a'], '', 20), ['a'])
  assert.deepEqual(nextHistory(undefined, 'x', 20), ['x'])
})

test('the history is trimmed to the configured depth', () => {
  const full = ['c', 'b', 'a']
  assert.deepEqual(nextHistory(full, 'd', 2), ['d', 'c'])
  assert.deepEqual(nextHistory(full, 'd', 1), ['d'])
})

const { scopedHistory } = new Function(`${slice('    const scopedHistory = ', '    /** The history a composer')}
return { scopedHistory }`)()

test('independent recall reads the Session’s own list, shared recall reads the global one', () => {
  const globalList = ['shared']
  const perSession = { 'session-a': ['a1', 'a2'], 'session-b': ['b1'] }
  assert.deepEqual(scopedHistory(false, 'session-a', globalList, perSession), ['shared'])
  assert.deepEqual(scopedHistory(true, 'session-a', globalList, perSession), ['a1', 'a2'])
  assert.deepEqual(scopedHistory(true, 'session-b', globalList, perSession), ['b1'])
})

test('an unknown or missing Session has no independent history', () => {
  const perSession = { 'session-a': ['a1'] }
  assert.deepEqual(scopedHistory(true, 'session-z', [], perSession), [])
  assert.deepEqual(scopedHistory(true, '', [], perSession), [])
  assert.deepEqual(scopedHistory(true, 'session-a', [], null), [])
  assert.deepEqual(scopedHistory(false, 'session-a', undefined, perSession), [])
})
