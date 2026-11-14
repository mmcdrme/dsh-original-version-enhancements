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
