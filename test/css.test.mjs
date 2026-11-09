// Regression tests for the stylesheet route.
//
// The plugin's CSS ships as `css/style.css` and the Host reads it on every
// request with `no-store`, which is what makes "edit the CSS, refresh the page"
// work without touching the client bundle. These tests pin that contract: the
// current bytes are served as CSS, and a missing or oversized file is reported
// instead of being answered with an empty stylesheet.

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const moduleUrl = new URL('../host/css.mjs', import.meta.url)
const { createStyleHandler } = await import(moduleUrl)

/** A minimal response double recording what the handler wrote. */
const makeResponse = () => {
  const response = {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      response.status = status
      response.headers = { ...headers }
      return response
    },
    end(chunk) {
      if (chunk !== undefined) response.body = String(chunk)
    },
  }
  return response
}

/** Write one stylesheet into a fresh directory and return its path. */
const stylesheetAt = async (contents) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ove-css-'))
  const file = path.join(directory, 'style.css')
  if (contents !== undefined) await writeFile(file, contents, 'utf8')
  return file
}

const call = async (handler, method = 'GET') => {
  const response = makeResponse()
  await handler({ method }, response)
  return response
}

test('serves the current file, uncached, as CSS', async () => {
  const file = await stylesheetAt('.ove-tab { color: red; }\n')
  const warnings = []
  const response = await call(createStyleHandler({ file, warn: (message) => warnings.push(message) }))

  assert.equal(response.status, 200)
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.equal(response.headers['content-type'], 'text/css; charset=utf-8')
  assert.equal(response.headers['content-disposition'], 'inline')
  assert.equal(response.body, '.ove-tab { color: red; }\n')
  assert.deepEqual(warnings, [])
})

test('a second request sees the rewritten file without any restart', async () => {
  const file = await stylesheetAt('.ove-tab { color: red; }\n')
  const handler = createStyleHandler({ file, warn: () => undefined })
  assert.match((await call(handler)).body, /red/)

  await writeFile(file, '.ove-tab { color: green; }\n', 'utf8')
  assert.match((await call(handler)).body, /green/)
})

test('HEAD answers with the headers but no body', async () => {
  const file = await stylesheetAt('.ove-tab { color: red; }\n')
  const response = await call(createStyleHandler({ file, warn: () => undefined }), 'HEAD')
  assert.equal(response.status, 200)
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.equal(response.body, '')
})

test('a missing file is a 500 that names the problem', async () => {
  const file = await stylesheetAt(undefined)
  const warnings = []
  const response = await call(createStyleHandler({ file, warn: (message) => warnings.push(message) }))
  assert.equal(response.status, 500)
  assert.match(response.body, /css\/style\.css/)
  assert.equal(warnings.length, 1)
})

test('only GET and HEAD are accepted', async () => {
  const file = await stylesheetAt('.ove-tab { color: red; }\n')
  const response = await call(createStyleHandler({ file, warn: () => undefined }), 'POST')
  assert.equal(response.status, 405)
})
