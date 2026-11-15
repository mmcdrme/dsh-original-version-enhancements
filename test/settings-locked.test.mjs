// Unit tests for the locked and scrolling behaviour of the settings page.
//
// A switched-off box keeps its rows (they are only inert). Opening a fold
// scrolls the dialog's option list in step with the fold's own 0.22 s: the view
// stops on the top edge of the next section's border, which clips that border
// away; a box too tall for the list is lined up by its top edge; and a box that
// is already fully readable moves nothing.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8')

/** Evaluate the shipped reveal helper against a fabricated dialog. */
const revealWith = (box, area, options = {}) => {
  const start = clientSource.indexOf('    /** The fold\'s own animation length')
  const end = clientSource.indexOf('    /**\n     * One "big setting" box:')
  assert.ok(start >= 0 && end > start, 'missing revealFoldedBox anchors')
  let clock = 0
  let frames = 0
  const body = {}
  const scroller = {
    scrollTop: options.scrollTop ?? 0,
    clientHeight: area.height,
    scrollHeight: options.scrollHeight ?? 2400,
    parentElement: body,
    getBoundingClientRect: () => area,
  }
  const sibling = options.nextTop === undefined
    ? null
    : { getBoundingClientRect: () => ({ top: options.nextTop }) }
  const node = {
    isConnected: true,
    parentElement: scroller,
    nextElementSibling: sibling,
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

test('the view stops on the top edge of the next section border', () => {
  // The next box starts 10 px below the opened one; one pixel past the edge
  // keeps its border itself clipped instead of drawing a stray line.
  const result = revealWith(
    { top: 700, bottom: 1100, height: 400 },
    AREA,
    { nextTop: 1110 },
  )
  assert.equal(result.scrollTop, 209)
})

test('a box too tall for the list is pinned by its top edge instead', () => {
  const result = revealWith({ top: 400, bottom: 1600, height: 1200 }, AREA, { nextTop: 1610 })
  assert.equal(result.scrollTop, 300)
})

test('a fold that is already fully readable is left alone', () => {
  const result = revealWith({ top: 200, bottom: 400, height: 200 }, AREA, { scrollTop: 500, nextTop: 410 })
  assert.equal(result.scrollTop, 500)
  assert.equal(result.frames, 0)
})

test('the last box has no section below, so it stops above the list padding', () => {
  const result = revealWith(
    { top: 700, bottom: 1100, height: 400 },
    AREA,
    { paddingBottom: '24px' },
  )
  // 1100 (box bottom) - 876 (visible bottom, 24 px of padding excluded)
  assert.equal(result.scrollTop, 224)
})

test('the rows a folded body is about to reveal count towards its height', () => {
  const result = revealWith(
    { top: 700, bottom: 760, height: 60 },
    AREA,
    { nextTop: 770, body: { scrollHeight: 300, clientHeight: 0 } },
  )
  // 770 (next box, collapsed) + 300 (rows) - 900 - 1
  assert.equal(result.scrollTop, 169)
})

test('the clamp counts the rows that are still opening', () => {
  const result = revealWith(
    { top: 700, bottom: 760, height: 60 },
    AREA,
    {
      nextTop: 770,
      scrollHeight: 600,
      body: { scrollHeight: 300, clientHeight: 0 },
    },
  )
  // The list can only reach 600 + 300 - 800 before the body has opened.
  assert.equal(result.scrollTop, 100)
})

test('the scroll runs for the fold duration and lands on the exact target', () => {
  const result = revealWith({ top: 700, bottom: 1100, height: 400 }, AREA, { nextTop: 1110 })
  assert.equal(result.api.FOLD_DURATION_MS, 220)
  // 110 ms steps: half way, then the final frame — two animation frames.
  assert.equal(result.frames, 2)
  assert.equal(result.scrollTop, 209)
})

test('reduced motion jumps to the target without animation', () => {
  const result = revealWith({ top: 700, bottom: 1100, height: 400 }, AREA, {
    nextTop: 1110,
    reduce: true,
  })
  assert.equal(result.frames, 0)
  assert.equal(result.scrollTop, 209)
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
