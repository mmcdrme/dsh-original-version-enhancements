// Regression tests for the split (in-page vs OS window) drag routing.
//
// The drag listeners are installed once per window-appearance change, so every
// appearance field the handlers read must be in the dependency list: the split
// switch was read at mount but missing from the deps, and toggling it did
// nothing until the page was reloaded.
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('../', import.meta.url)
const client = await readFile(new URL('client.js', root), 'utf8')

test('the drag listeners depend on every appearance field they read', () => {
  const deps = client.match(/\}, \[ctx, tr, windowAppearance\.[^\]]*\]\);/)
  assert.ok(deps, 'the drag listener effect carries a dependency list')
  assert.match(deps[0], /windowAppearance\.mode/)
  assert.match(deps[0], /windowAppearance\.split/)
})

test('split mode routes the drop zone to a window shape', () => {
  assert.match(client, /const splitWindows = windowAppearance\.split === true;/)
  assert.match(client, /zone === 'outside' \? 'native' : 'panel'/)
})

test('the drag watchdog stops itself once the gesture belongs to someone else', () => {
  const start = client.indexOf('state.timer = globalThis.setInterval(')
  assert.ok(start >= 0, 'the watchdog interval exists')
  const block = client.slice(start, start + 800)
  assert.match(block, /if \(live !== state\) \{/)
  assert.match(block, /clearInterval\(state\.timer\)/)
  assert.match(block, /state\.timer = 0;/)
})
