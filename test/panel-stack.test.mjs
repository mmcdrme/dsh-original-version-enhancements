// Unit tests for the in-page window stack.
//
// Raising a window must only change its z-index: reordering the rendered
// elements moves the iframes in the DOM, which reloads their documents.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8')

/** Evaluate the shipped panel stack against inert listener stubs. */
const stack = () => {
  const start = clientSource.indexOf('    let panelIds = new Set();')
  const end = clientSource.indexOf('    /** Drop every mark and close the windows this page opened. */')
  assert.ok(start >= 0 && end > start, 'missing panel stack anchors')
  const factory = new Function('React', `${clientSource.slice(start, end)}
return { openDetachedPanel, raiseDetachedPanel, dropDetachedPanel, getPanels, getPanelOrder }`)
  return factory({ useSyncExternalStore: () => undefined })
}

test('opening windows keeps render order and stack order in step', () => {
  const panels = stack()
  panels.openDetachedPanel('a')
  panels.openDetachedPanel('b')
  assert.deepEqual([...panels.getPanels()], ['a', 'b'])
  assert.deepEqual(panels.getPanelOrder(), ['a', 'b'])
})

test('raising a window only moves it in the stack', () => {
  const panels = stack()
  panels.openDetachedPanel('a')
  panels.openDetachedPanel('b')
  const rendered = [...panels.getPanels()]
  panels.raiseDetachedPanel('a')
  assert.deepEqual([...panels.getPanels()], rendered, 'render order must not change')
  assert.deepEqual(panels.getPanelOrder(), ['b', 'a'])
})

test('raising the front window is a no-op', () => {
  const panels = stack()
  panels.openDetachedPanel('a')
  panels.openDetachedPanel('b')
  panels.raiseDetachedPanel('b')
  assert.deepEqual(panels.getPanelOrder(), ['a', 'b'])
})

test('closing a window takes it out of both orders', () => {
  const panels = stack()
  panels.openDetachedPanel('a')
  panels.openDetachedPanel('b')
  panels.raiseDetachedPanel('a')
  panels.dropDetachedPanel('b')
  assert.deepEqual([...panels.getPanels()], ['a'])
  assert.deepEqual(panels.getPanelOrder(), ['a'])
})

test('a press inside a frame raises that window', () => {
  assert.match(clientSource, /data\.source !== 'ove-detached-raise'/u)
  assert.match(clientSource, /raiseDetachedPanel\(sessionId\);/u)
})

test('the rendered frames take their z-index from the stack, not their index', () => {
  assert.match(clientSource, /zIndex: panelOrder\.indexOf\(sessionId\),/u)
  assert.match(clientSource, /\/\/ Stacking follows the last click, not the render order\./u)
  // Raising must not push a fresh membership set: that was the reorder that
  // reloaded the frames.
  const raise = clientSource.slice(
    clientSource.indexOf('    const raiseDetachedPanel = (sessionId) => {'),
    clientSource.indexOf('    const dropDetachedPanel = (sessionId) => {'),
  )
  assert.doesNotMatch(raise, /publishPanels/u)
  assert.match(raise, /publishPanelOrder/u)
})
