// Unit tests for the locked and scrolling behaviour of the settings page.
//
// A switched-off box keeps its rows (they are only inert). Opening a fold
// scrolls the dialog's option list in step with the fold's own 0.22 s; closing
// one scrolls it by the part of the body that slid away above the view, so the
// rows being read stay put. A box too tall for the list is lined up below the
// top edge (never glued to it), and a box that is already fully readable moves
// nothing.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8')
const stylesheet = await readFile(new URL('../css/style.css', import.meta.url), 'utf8')

const AREA = { top: 100, bottom: 900, height: 800 }

/** Evaluate the shipped scroll helpers against a fabricated dialog. */
const harness = (area = AREA, options = {}) => {
  const start = clientSource.indexOf('    /** The fold\'s own animation length')
  const end = clientSource.indexOf('    /**\n     * One "big setting" box:')
  assert.ok(start >= 0 && end > start, 'missing fold scroll anchors')
  let clock = 0
  let frames = 0
  const bodySentinel = {}
  const scroller = {
    scrollTop: options.scrollTop ?? 0,
    clientHeight: area.height,
    scrollHeight: options.scrollHeight ?? 2400,
    parentElement: bodySentinel,
    getBoundingClientRect: () => area,
  }
  const timers = []
  const window = {
    requestAnimationFrame: (callback) => {
      clock += 110
      frames += 1
      callback(clock)
    },
  }
  const document = { body: bodySentinel }
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

return { revealFoldedBox, settleFoldedBox, FOLD_DURATION_MS, FOLD_TOP_GAP }`,
  )
  const api = factory(window, document, getComputedStyle, performance, globalThisStub)
  /** The clipping wrapper: reveal measures the opened height through it. */
  const wrapper = { style: { transition: '', gridTemplateRows: '' } }
  const node = (box, nextTop) => ({
    isConnected: true,
    parentElement: scroller,
    nextElementSibling: nextTop === undefined
      ? null
      : { getBoundingClientRect: () => ({ top: nextTop }) },
    // The real box grows while the wrapper is forced open for measurement.
    getBoundingClientRect: () => (wrapper.style.gridTemplateRows === '1fr'
      ? (options.expanded ?? box)
      : box),
  })
  return {
    api,
    scroller,
    node,
    wrapper,
    frames: () => frames,
    timers,
  }
}

/** Reveal a box whose body is folded: `bodySpec` is its in-page rectangle. */
const revealWith = (box, area, options = {}) => {
  const run = harness(area, options)
  const body = options.body === undefined
    ? null
    : {
      parentElement: run.wrapper,
      scrollHeight: options.body.scrollHeight,
      clientHeight: options.body.clientHeight,
      getBoundingClientRect: () => options.body.rect ?? { height: 0 },
    }
  run.api.revealFoldedBox(run.node(box, options.nextTop), body)
  return { scrollTop: run.scroller.scrollTop, frames: run.frames(), api: run.api, wrapper: run.wrapper }
}

/** Close a box whose body is `bodyRect` high at `bodyRect.top` on screen. */
const settleWith = (bodyRect, area, options = {}) => {
  const run = harness(area, options)
  run.api.settleFoldedBox(run.node({ top: 0, bottom: 0, height: 0 }), {
    getBoundingClientRect: () => bodyRect,
  })
  return { scrollTop: run.scroller.scrollTop, frames: run.frames() }
}

test('the view stops on the top edge of the next section border', () => {
  // The next box starts 10 px below the opened one; one pixel past the edge
  // keeps its border itself clipped instead of drawing a stray line.
  const result = revealWith({ top: 700, bottom: 1100, height: 400 }, AREA, { nextTop: 1110 })
  assert.equal(result.scrollTop, 209)
})

test('a box too tall for the list keeps some air above its head', () => {
  const result = revealWith({ top: 400, bottom: 1600, height: 1200 }, AREA, { nextTop: 1610 })
  // Aligned at the content top would clip the border, so the box starts one
  // gap lower: 400 - 100 - 12.
  assert.equal(result.scrollTop, 288)
  assert.equal(result.api.FOLD_TOP_GAP, 12)
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
  // Opening the wrapper for one layout pass reports the real opened height:
  // the folded box is 60 px tall and grows to 360 px (300 px of rows).
  const result = revealWith(
    { top: 700, bottom: 760, height: 60 },
    AREA,
    {
      nextTop: 770,
      expanded: { top: 700, bottom: 1060, height: 360 },
      body: { scrollHeight: 300, clientHeight: 0 },
    },
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
      expanded: { top: 700, bottom: 1060, height: 360 },
      body: { scrollHeight: 300, clientHeight: 0 },
    },
  )
  // The list can only reach 600 + 300 - 800 before the body has opened.
  assert.equal(result.scrollTop, 100)
})

test('the open scroll runs for the fold duration and lands on the target', () => {
  const result = revealWith({ top: 700, bottom: 1100, height: 400 }, AREA, { nextTop: 1110 })
  assert.equal(result.api.FOLD_DURATION_MS, 220)
  // 110 ms steps: half way, then the final frame — two animation frames.
  assert.equal(result.frames, 2)
  assert.equal(result.scrollTop, 209)
})

test('the measured height keeps an opened box off the clip edge in one scroll', () => {
  // The recall box as it really is: 88 px folded, 474 px opened (386 px of
  // rows). The old `scrollHeight` estimate was 10 px short, which left its
  // bottom border sitting exactly on the list's clip edge — and it used to be
  // corrected by a second, delayed scroll, which read as a stutter. The real
  // measurement gets there in the fold's own single scroll.
  const result = revealWith(
    { top: 526, bottom: 614, height: 88 },
    AREA,
    {
      nextTop: 624,
      expanded: { top: 526, bottom: 1000, height: 474 },
      body: { scrollHeight: 380, clientHeight: 4 },
    },
  )
  // next top after growing: 624 + 386 = 1010; view stops one pixel past 900.
  assert.equal(result.scrollTop, 109)
  // One animated scroll only, and the wrapper is handed back untouched.
  assert.equal(result.frames, 2)
  assert.equal(result.wrapper.style.transition, '')
  assert.equal(result.wrapper.style.gridTemplateRows, '')
})

test('measuring a fold that stays fully readable does not scroll', () => {
  const result = revealWith(
    { top: 200, bottom: 400, height: 200 },
    AREA,
    {
      scrollTop: 500,
      nextTop: 410,
      expanded: { top: 200, bottom: 400, height: 200 },
      body: { scrollHeight: 196, clientHeight: 0 },
    },
  )
  assert.equal(result.scrollTop, 500)
  assert.equal(result.frames, 0)
})

test('closing a fold that sits in the view moves nothing', () => {
  // Body top 700 on screen, view top 100 → nothing of it is above the view.
  const result = settleWith({ top: 700, height: 400 }, AREA)
  assert.equal(result.scrollTop, 0)
  assert.equal(result.frames, 0)
})

test('closing a fold above the view scrolls up by the swallowed height', () => {
  // Scroll 1000, body top at content 600 with 300 px height: all of it is
  // above the view, so the list follows by the full 300 px.
  const result = settleWith({ top: -746, height: 300 }, AREA, { scrollTop: 1000 })
  assert.equal(result.scrollTop, 700)
})

test('a fold only partly above the view is followed by that part', () => {
  // Body top at content 900, scroll 1000: 100 px of it is above the view.
  const result = settleWith({ top: 0, height: 300 }, AREA, { scrollTop: 1000 })
  assert.equal(result.scrollTop, 900)
})

test('the closing scroll never runs past the shorter list', () => {
  // 300 px vanish, but only 400 px of further content remain scrollable.
  const result = settleWith({ top: -746, height: 300 }, AREA, {
    scrollTop: 1000,
    scrollHeight: 1800,
  })
  assert.equal(result.scrollTop, 700)
})

test('reduced motion jumps to the target without animation', () => {
  const result = revealWith({ top: 700, bottom: 1100, height: 400 }, AREA, {
    nextTop: 1110,
    reduce: true,
  })
  assert.equal(result.frames, 0)
  assert.equal(result.scrollTop, 209)
})

test('the opened height is measured without animating the wrapper back', () => {
  const start = clientSource.indexOf("    /** The fold's own animation length")
  const end = clientSource.indexOf('    /**\n     * One "big setting" box:')
  const source = clientSource.slice(start, end)
  assert.match(source, /const measureFoldGrowth = \(node, body, foldedHeight\) => \{/u)
  assert.match(source, /style\.transition = 'none';\n\s+style\.gridTemplateRows = '1fr';/u)
  // The rows are folded again while transitions are still off, the folded
  // layout is made current, and only then is the transition handed back: the
  // other order animated the box from its measured open height back to folded
  // before it opened, which is exactly what read as a stutter.
  assert.match(
    source,
    /style\.gridTemplateRows = previousRows;\n\s+node\.getBoundingClientRect\(\);\n\s+style\.transition = previousTransition;/u,
  )
})

test('the fold clips on its wrapper, not on the body that holds the switch', () => {
  // A switch sits on the body's right edge, so clipping there cut the right
  // half of its 3 px hover ring off. The wrapper clips and is 4 px wider on the
  // right (margin pulled back), leaving the ring its room.
  const wrapper = stylesheet.slice(stylesheet.indexOf('.ove-setting-collapse {'))
  const wrapperBlock = wrapper.slice(0, wrapper.indexOf('}'))
  assert.match(wrapperBlock, /overflow: hidden;/u)
  assert.match(wrapperBlock, /padding-right: 4px;/u)
  assert.match(wrapperBlock, /margin-right: -4px;/u)
  const bodyLine = stylesheet.split('\n').find(line => line.startsWith('.ove-setting-body { '))
  assert.doesNotMatch(bodyLine, /overflow: hidden/u)
  const foldBodyLine = stylesheet.split('\n').find(line => line.startsWith('.ove-fold-body { '))
  assert.doesNotMatch(foldBodyLine, /overflow: hidden/u)
})

test('the persistence switch is not tied to the recall mode', () => {
  const persist = clientSource.slice(
    clientSource.indexOf("settingRow(tr('recall.persist')"),
    clientSource.indexOf("// How deep the stack goes sits right below it."),
  )
  assert.ok(persist.length > 0, 'missing the persistence row')
  // The control is switchOf(checked, onToggle, label) — a fourth argument used
  // to disable it whenever shared mode was on.
  assert.doesNotMatch(persist, /recall\.perSession !== true/u)
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
