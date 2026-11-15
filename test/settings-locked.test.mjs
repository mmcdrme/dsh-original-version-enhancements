// Unit tests for the locked and scrolling behaviour of the settings page.
//
// A switched-off box keeps its rows (they are only inert), and opening a fold
// scrolls it into the dialog's option list: bottom edge when the whole box
// fits, top edge when it cannot.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8')

/** Evaluate the shipped reveal helper against a fabricated dialog. */
const revealWith = (box, area, scrollTop = 0) => {
  const start = clientSource.indexOf('    /**\n     * Bring a fold the human just opened into view')
  const end = clientSource.indexOf('    /**\n     * One "big setting" box:')
  assert.ok(start >= 0 && end > start, 'missing revealFoldedBox anchors')
  const calls = []
  const body = {}
  const scroller = {
    scrollTop,
    clientHeight: area.height,
    scrollHeight: 2000,
    parentElement: body,
    getBoundingClientRect: () => area,
    scrollTo: (options) => { calls.push(options) },
  }
  const node = {
    isConnected: true,
    parentElement: scroller,
    getBoundingClientRect: () => box,
  }
  const window = { setTimeout: (fn) => fn() }
  const document = { body }
  const getComputedStyle = () => ({ overflowY: 'auto' })
  const factory = new Function('window', 'document', 'getComputedStyle', `${clientSource.slice(start, end)}
return revealFoldedBox`)
  const revealFoldedBox = factory(window, document, getComputedStyle)
  revealFoldedBox(node)
  return calls
}

test('a box that fits is pinned by its bottom edge to the list bottom', () => {
  const calls = revealWith(
    { top: 700, bottom: 1100, height: 400 },
    { top: 100, bottom: 900, height: 800 },
  )
  assert.equal(calls.length, 1)
  assert.equal(calls[0].top, 200)
  assert.equal(calls[0].behavior, 'smooth')
})

test('a box too tall for the list is pinned by its top edge instead', () => {
  const calls = revealWith(
    { top: 400, bottom: 1600, height: 1200 },
    { top: 100, bottom: 900, height: 800 },
  )
  assert.equal(calls.length, 1)
  assert.equal(calls[0].top, 294)
})

test('an already visible box is left alone', () => {
  const calls = revealWith(
    { top: 200, bottom: 400, height: 200 },
    { top: 100, bottom: 900, height: 800 },
  )
  assert.deepEqual(calls, [])
})

test('a switched-off box keeps its rows but makes them inert', () => {
  assert.match(clientSource, /const locked = hasBody && checked === false;/u)
  assert.match(clientSource, /if \(node !== null\) node\.inert = locked;/u)
  assert.match(clientSource, /className: `ove-setting-body\$\{locked \? ' is-locked' : ''\}`/u)
  // No feature may hide its body again: the rows exist, only input stops.
  assert.doesNotMatch(clientSource, /flags\.\w+ === true\s*\n\s*\? \[/u)
})

test('switching a feature off folds its box, switching it on leaves it', () => {
  assert.match(clientSource, /if \(checked === true\) setSettingOpen\(key, false\);/u)
  assert.match(clientSource, /if \(settings\.enabled === true\) setSettingOpen\('subagentTree', false\);/u)
  // The old "expand when turning on" behaviour must stay gone.
  assert.doesNotMatch(clientSource, /checked !== true && body !== null/u)
})
