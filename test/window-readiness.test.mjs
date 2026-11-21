// Regression tests for the detached-window readiness contract (v1.37.59).
//
// The window used to call itself ready as soon as navigation state changed, so
// the Host cleared its startup grace period while the page was still on the
// app's welcome screen, and the companion exe lifted its loading cover over
// that screen. These assertions lock the two halves of the fix:
//   - client.js reports ready only once the conversation is actually mounted,
//     and waits for the catalogue before asking to open the session;
//   - OveWindow.cs turns a timeout into a failure state, never into a reveal.
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('../', import.meta.url)
const client = await readFile(new URL('client.js', root), 'utf8')
const native = await readFile(new URL('native/OveWindow.cs', root), 'utf8')

const between = (text, start, end) => {
  const from = text.indexOf(start)
  assert.notEqual(from, -1, 'missing anchor: ' + start)
  const to = text.indexOf(end, from + start.length)
  assert.notEqual(to, -1, 'missing end anchor: ' + end)
  return text.slice(from, to)
}

test('the embedded window waits for a mounted conversation before reporting ready', () => {
  const block = between(client, 'const mounted = () => {', 'const catalogued = () => {')
  assert.match(block, /data-chat-flow/)
  assert.match(block, /data-content-phase/)
  const effect = between(client, 'const timer = window.setInterval(() => {', '}, 300);')
  assert.match(effect, /if \(mounted\(\)\)/)
  assert.match(effect, /settled < 2/)
  const readyAt = effect.indexOf("announce('ready')")
  const mountedAt = effect.indexOf('if (mounted())')
  assert.ok(mountedAt !== -1 && readyAt > mountedAt, 'ready must be announced only after the mount check')
})

test('the embedded window waits for the catalogue before opening the session', () => {
  const block = between(client, 'const catalogued = () => {', 'const reloadKey =')
  assert.match(block, /getSnapshot/)
  assert.match(block, /byId/)
  const effect = between(client, 'const timer = window.setInterval(() => {', '}, 300);')
  assert.match(effect, /if \(catalogued\(\)\)/)
})

test('a stuck selection reboots the document once, then reports failure', () => {
  const block = between(client, 'const reloadKey =', '}, [ctx, detachedId]);')
  assert.match(block, /ove-detached-reloaded/)
  assert.match(block, /location\?\.reload\?\.\(\)/)
  assert.match(block, /reloadTried === false/)
  assert.match(block, /Date\.now\(\) - matchedSince > 14000/)
  assert.match(block, /announce\('failed'\)/)
})

test('the companion exe shows a failure state on timeout instead of revealing the page', () => {
  const handler = between(native, 'private void OnWebMessage(', 'private void Reveal()')
  assert.match(handler, /message == "ove-ready"/)
  assert.match(handler, /if \(message == "ove-timeout"\) ShowLoadFailure\("无法加载会话/)
  assert.doesNotMatch(handler, /message == "ove-ready" \|\| message == "ove-timeout"/)
  assert.match(native, /private void ShowLoadFailure\(string message = "无法连接本机服务/)
})
