// Regression tests for how a conversation reaches its own OS window (v1.37.61).
//
// The only two gestures that may start a companion window are the session
// menu's explicit item and a real drag that ends outside the page. The drag
// detector used to fire for ordinary in-app drags: `dragleave` reports a null
// relatedTarget while the pointer is still inside the document, so a drag that
// never left the window could spawn one. These assertions lock the guards and
// the origin tag the Host logs.
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('../', import.meta.url)
const client = await readFile(new URL('client.js', root), 'utf8')
const host = await readFile(new URL('host/native-window.mjs', root), 'utf8')

const between = (text, start, end) => {
  const from = text.indexOf(start)
  assert.notEqual(from, -1, 'missing anchor: ' + start)
  const to = text.indexOf(end, from + start.length)
  assert.notEqual(to, -1, 'missing end anchor: ' + end)
  return text.slice(from, to)
}

test('a drag must move, end outside and not be an accepted drop to detach', () => {
  const effect = between(client, 'let dragging = null;', '}, [ctx, tr, windowAppearance.mode]);')
  assert.match(effect, /moved: false/u)
  assert.match(effect, /state\.moved = true/u)
  assert.match(effect, /dropped = true/u)
  assert.match(effect, /if \(state\.moved !== true\) return;/u)
  assert.match(effect, /const zone = zoneOf\(point\)/u)
  assert.match(effect, /if \(state\.zone === 'workspace' && !rawOutside\) return;/u)
  // Only a real drop event separates "reorder" from "detach"; the dropEffect a
  // hovered row left behind must not be mistaken for one.
  assert.match(effect, /dragging\.dropped = true/u)
  assert.doesNotMatch(effect, /dropEffect !== 'none'/u)
  assert.match(effect, /window\.innerWidth - 2/u)
  // `dragleave` with a null relatedTarget is what misfired before: it must
  // not decide the detach. It may only paint the hint, and only for
  // coordinates that are really outside the viewport.
  assert.doesNotMatch(effect, /if \(event\.relatedTarget === null\) dragging\.outside = true;/u)
  const leave = between(effect, 'const onDragLeave = (event) => {', 'const onDrop = () => {')
  assert.match(leave, /if \(zone === 'outside'\)/u)
  assert.match(leave, /hintPreview\(dragging, labelFor\('detachDragHint'/u)
  assert.match(effect, /addEventListener\('drop', onDrop, true\)/u)
})

test('the menu item and the drag handler tag their request', () => {
  assert.match(client, /reason: 'menu'/u)
  assert.match(client, /reason: 'drag'/u)
  assert.match(client, /openNativeWindow\(sessionId, appearance, labels\?\.reason \?\? 'unknown'\)/u)
  assert.match(client, /reason,\n\s+\/\/ The window is the conversation alone/u)
})

test('the Host logs which gesture opened a window', () => {
  assert.match(host, /const reason = typeof options\.reason === 'string'/u)
  assert.match(host, /opening a window for \$\{sessionId\} \(\$\{reason\}\)/u)
})
