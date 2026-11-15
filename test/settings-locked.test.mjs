// Unit tests for the locked and scrolling behaviour of the settings page.
//
// A switched-off box keeps its rows (they are only inert), and opening a fold
// scrolls it into the dialog's option list in step with the fold's own 0.22 s:
// bottom edge when the whole box fits, top edge when it cannot, and nothing at
// all when the box is already fully readable.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8')

/** Evaluate the shipped reveal helper against a fabricated dialog. */
const revealWith = (box, area, options = {}) => {
  const start = clientSource.indexOf('    /** The fold\'s own animation length')
  const end = clientSource.indexOf('    /**\n     * One "big setting" box:')
  assert.ok(start >= 0 && end > start, 'missing revealFoldedBox anchors')
  let clock = 0;
  let frames = 0
  const body = {}
  const scroller = {
    scrollTop: options.scrollTop ?? 0,
    clientHeight: area.height,
    scrollHeight: options.scrollHeight ?? 2400,
    parentElement: body,
    getBoundingClientRect: () => area,
  }
  const node = {
    isConnected: true,
    parentElement: scroller,
    getBoundingClientRect: () => box,
  }
  const window = {
    requestAnimationFrame: (callback) => {
      clock += 110
      frames += 1
      callback(clock)
    },
  }
  const document = { body }
  const getComputedStyle = () => ({
    overflowY: 'auto',
    paddingTop: options.paddingTop ?? '0px',
    paddingBottom: options.paddingBottom ?? '0px',
  })
  const performance = { now: () => clock }
  const globalThisStub = { matchMedia: () => ({ matches: options.reduce === true }) }
  const factory = new Function(
    'window', 'document', 'getComputedStyle', 'performance', 'globalThis',
    `${clientSource.slice(start, end)}

return { revealFoldedBox, FOLD_DURATION_MS }`,
  )
  const api = factory(window, document, getComputedStyle, performance, globalThisStub)
  api.revealFoldedBox(node, options.body ?? null)
  return { scrollTop: scroller.scrollTop, frames, api }
}

const AREA = { top: 100, bottom: 900, height: 800 }

test('a box that fits is pinned by its bottom edge, above the list padding', () => {
  const result = revealWith(
    { top: 700, bottom: 1100, height: 400 },
    AREA,
    { paddingBottom: '24px' },
  )
  // 1100 (box bottom) - 876 (visible bottom, 24 px of padding excluded)
  assert.equal(result.scrollTop, 224)
})

test('a box too tall for the list is pinned by its top edge instead', () => {
  const result = revealWith({ top: 400, bottom: 1600, height: 1200 }, AREA)
  assert.equal(result.scrollTop, 300)
})

test('a fold that is already fully readable is left alone', () => {
  const result = revealWith({ top: 200, bottom: 400, height: 200 }, AREA, { scrollTop: 500 })
  assert.equal(result.scrollTop, 500)
  assert.equal(result.frames, 0)
})

test('a partially hidden fold below the list is only scrolled as far as needed', () => {
  const result = revealWith(
    { top: 760, bottom: 1080, height: 320 },
    AREA,
    { scrollTop: 500, paddingBottom: '24px' },
  )
  // Nothing is cut off at the top, so the bottom edge is the only rule:
  // 500 + (1080 - 876)
  assert.equal(result.scrollTop, 704)
})

test('the rows a folded body is about to reveal count towards its height', () => {
  const result = revealWith(
    { top: 700, bottom: 760, height: 60 },
    AREA,
    { paddingBottom: '24px', body: { scrollHeight: 300, clientHeight: 0 } },
  )
  // 760 (collapsed) + 300 (rows) - 876
  assert.equal(result.scrollTop, 184)
})

test('the clamp counts the rows that are still opening', () => {
  // Everything folded: the list is nearly at its end, yet the move must reach
  // the position the opened box will occupy.
  const result = revealWith(
    { top: 700, bottom: 760, height: 60 },
    AREA,
    {
      paddingBottom: '24px',
      scrollHeight: 800,
      body: { scrollHeight: 300, clientHeight: 0 },
    },
  )
  assert.equal(result.scrollTop, 184)
})

test('the scroll runs for the fold duration and lands on the exact target', () => {
  const result = revealWith({ top: 700, bottom: 1100, height: 400 }, AREA, { paddingBottom: '24px' })
  assert.equal(result.api.FOLD_DURATION_MS, 220)
  // 110 ms steps: half way, then the final frame — two animation frames.
  assert.equal(result.frames, 2)
  assert.equal(result.scrollTop, 224)
})

test('reduced motion jumps to the target without animation', () => {
  const result = revealWith({ top: 700, bottom: 1100, height: 400 }, AREA, {
    paddingBottom: '24px',
    reduce: true,
  })
  assert.equal(result.frames, 0)
  assert.equal(result.scrollTop, 224)
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
