// Unit tests for the native detached-window Host half.
//
// No window is started: the command line the companion host receives and the
// state routes are what this file pins down.

import assert from 'node:assert/strict'
import test from 'node:test'

import { createNativeWindows, windowArguments } from '../host/native-window.mjs'

test('the companion window receives its URL, session page and geometry', () => {
  const args = windowArguments({
    bootUrl: 'http://127.0.0.1:4850/?token=abc',
    appUrl: 'http://127.0.0.1:4850/plugins/original-version-enhancements/window?session=session-s1',
    title: '会话一',
    width: 902,
    height: 672,
    opacity: 80,
    mute: true,
    dataDir: 'C:/tmp/wv2',
  })
  assert.deepEqual(args, [
    '--url', 'http://127.0.0.1:4850/?token=abc',
    '--app-url', 'http://127.0.0.1:4850/plugins/original-version-enhancements/window?session=session-s1',
    '--title', '会话一',
    '--width', '902',
    '--height', '672',
    '--opacity', '80',
    '--mute', '1',
    '--data-dir', 'C:/tmp/wv2',
  ])
})

test('a missing title falls back to the window label', () => {
  const args = windowArguments({ bootUrl: 'u', appUrl: 'a', title: '', width: 1, height: 1, opacity: 100, dataDir: 'd' })
  assert.equal(args[args.indexOf('--mute') + 1], '1')
  assert.equal(args[args.indexOf('--title') + 1], '独立会话窗口')
})

test('state reports an empty list and the platform capability', async () => {
  const windows = createNativeWindows({
    origin: () => 'http://127.0.0.1:4850',
    authenticatedUrl: url => `${url}?token=x`,
    isTrustedRequest: () => true,
  })
  const body = await new Promise((resolve, reject) => {
    const res = {
      writeHead() {},
      end(text) { resolve(JSON.parse(text)) },
    }
    windows.handlers.state({ method: 'GET' }, res).catch(reject)
  })
  assert.equal(body.ok, true)
  assert.deepEqual(body.windows, [])
  assert.equal(typeof body.supported, 'boolean')
})

test('open and close refuse a non-POST method before touching any process', async () => {
  const windows = createNativeWindows({
    origin: () => 'http://127.0.0.1:4850',
    authenticatedUrl: url => `${url}?token=x`,
    isTrustedRequest: () => true,
  })
  for (const handler of [windows.handlers.open, windows.handlers.close, windows.handlers.ready]) {
    const status = await new Promise((resolve, reject) => {
      const res = {
        writeHead(value) { resolve(value) },
        end() {},
      }
      handler({ method: 'GET' }, res).catch(reject)
    })
    assert.equal(status, 405)
  }
})

test('a cross-origin open request is refused', async () => {
  const windows = createNativeWindows({
    origin: () => 'http://127.0.0.1:4850',
    authenticatedUrl: url => `${url}?token=x`,
    isTrustedRequest: () => false,
  })
  const status = await new Promise((resolve, reject) => {
    const res = {
      writeHead(value) { resolve(value) },
      end() {},
    }
    windows.handlers.open({ method: 'POST' }, res).catch(reject)
  })
  assert.equal(status, 403)
})

test('the window follows its parent and the shared appearance file', () => {
  const args = windowArguments({
    bootUrl: 'u',
    appUrl: 'a',
    title: 't',
    width: 900,
    height: 700,
    opacity: 60,
    mute: false,
    dataDir: 'C:/tmp/wv2',
    parentPid: 4242,
    appearanceFile: 'C:/tmp/appearance.json',
  })
  assert.equal(args[args.indexOf('--parent-pid') + 1], '4242')
  assert.equal(args[args.indexOf('--appearance') + 1], 'C:/tmp/appearance.json')
})

test('the appearance route writes what every window polls', async () => {
  const { readFile, rm } = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  const file = fileURLToPath(new URL('../.webview-data/appearance.json', import.meta.url))
  await rm(file, { force: true }).catch(() => {})
  const windows = createNativeWindows({
    origin: () => 'http://127.0.0.1:4850',
    authenticatedUrl: url => `${url}?token=x`,
    isTrustedRequest: () => true,
  })
  const request = {
    method: 'POST',
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify({ opacity: 45, mute: false }))
    },
  }
  const body = await new Promise((resolve, reject) => {
    const res = { writeHead() {}, end(text) { resolve(JSON.parse(text)) } }
    windows.handlers.appearance(request, res).catch(reject)
  })
  assert.deepEqual(body, { ok: true })
  const payload = JSON.parse(await readFile(file, 'utf8'))
  assert.deepEqual(payload, { opacity: 45, mute: false })
  await rm(file, { force: true })
})

/** A child-process stand-in with just what the window lifecycle touches. */
const fakeChild = async () => {
  const { EventEmitter } = await import('node:events')
  const child = new EventEmitter()
  child.killed = false
  child.exitCode = null
  child.kill = () => {
    child.killed = true
    child.exitCode = 0
    child.emit('exit', 0, null)
  }
  return child
}

/** Drive the open route with a JSON body, the way the plugin page does. */
const openWindow = async (windows, sessionId = 'session-s1') => {
  const request = {
    method: 'POST',
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify({
        sessionId,
        title: 't',
        width: 900,
        height: 700,
        opacity: 100,
        mute: true,
      }))
    },
  }
  return await new Promise((resolve, reject) => {
    const res = { writeHead() {}, end(text) { resolve(JSON.parse(text)) } }
    windows.handlers.open(request, res).catch(reject)
  })
}

/** POST /ready for a window, resolving once the host answers. */
const markReady = async (windows, sessionId = 'session-s1') => {
  const request = {
    method: 'POST',
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify({ sessionId }))
    },
  }
  return await new Promise((resolve, reject) => {
    const res = { writeHead() {}, end(text) { resolve(JSON.parse(text)) } }
    windows.handlers.ready(request, res).catch(reject)
  })
}

const windowState = async (windows) => await new Promise((resolve, reject) => {
  const res = { writeHead() {}, end(text) { resolve(JSON.parse(text)) } }
  windows.handlers.state({ method: 'GET' }, res).catch(reject)
})

test('a window that never reports ready is closed after the grace period', async () => {
  const child = await fakeChild()
  const windows = createNativeWindows({
    origin: () => 'http://127.0.0.1:4850',
    authenticatedUrl: url => `${url}?token=x`,
    isTrustedRequest: () => true,
    spawnWindow: () => child,
    startupTimeoutMs: 30,
  })
  const result = await openWindow(windows)
  assert.equal(result.ok, true)
  assert.equal(child.killed, false, 'the window must be allowed to start')
  await new Promise(resolve => setTimeout(resolve, 90))
  assert.equal(child.killed, true, 'a window that never turns ready must be killed')
  assert.deepEqual((await windowState(windows)).windows, [])
})

test('reporting ready keeps the window and stops the grace timer', async () => {
  const child = await fakeChild()
  const windows = createNativeWindows({
    origin: () => 'http://127.0.0.1:4850',
    authenticatedUrl: url => `${url}?token=x`,
    isTrustedRequest: () => true,
    spawnWindow: () => child,
    startupTimeoutMs: 30,
  })
  await openWindow(windows, 'session-s2')
  const ready = await markReady(windows, 'session-s2')
  assert.equal(ready.ok, true)
  await new Promise(resolve => setTimeout(resolve, 90))
  assert.equal(child.killed, false, 'a ready window must stay open')
  assert.equal((await windowState(windows)).windows.length, 1)
  windows.closeAll()
  assert.equal(child.killed, true)
})

test('a dead child does not block a fresh window for the same conversation', async () => {
  const first = await fakeChild()
  const second = await fakeChild()
  const children = [first, second]
  const windows = createNativeWindows({
    origin: () => 'http://127.0.0.1:4850',
    authenticatedUrl: url => `${url}?token=x`,
    isTrustedRequest: () => true,
    spawnWindow: () => children.shift(),
    startupTimeoutMs: 5000,
  })
  await openWindow(windows, 'session-s3')
  first.exitCode = 1
  first.emit('exit', 1, null)
  const again = await openWindow(windows, 'session-s3')
  assert.equal(again.ok, true)
  assert.notEqual(again.reused, true, 'a fresh process must be started')
  windows.closeAll()
})

test('the window host can end itself when its UI thread wedges', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../native/OveWindow.cs', import.meta.url), 'utf8')
  // The failure this guards against: a window whose message pump stopped is
  // left in Alt+Tab as a frozen frame that nothing can close.
  assert.match(source, /internal static void HardExit\(int code\)/u)
  assert.match(source, /Process\.GetCurrentProcess\(\)\.Kill\(\)/u)
  assert.match(source, /private void StartStartupWatchdog\(\)/u)
  assert.match(source, /private void StartLivenessWatch\(\)/u)
  assert.match(source, /case "--startup-timeout"/u)
  // A closed window takes its process with it instead of leaving a headless husk.
  assert.match(source, /finally[\s\S]{0,400}?HardExit\(0\);/u)
})
