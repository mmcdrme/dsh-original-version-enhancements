// Regression tests for the Host's HTTP plumbing (host/serve.mjs).
//
// The stylesheet and the language catalogue are files on disk served fresh on
// every request with `no-store`, which is what makes "edit the file, refresh the
// page" work without touching the client bundle; a missing, oversized or
// malformed file must be reported, never answered with an empty 200. The JSON
// reader every POST route uses is pinned here too: bounded, and empty bodies
// only where a route opts in.

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const {
  createLangHandler,
  createStyleHandler,
  readJsonBody,
  MAX_REQUEST_BYTES,
} = await import(new URL('../host/serve.mjs', import.meta.url))

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

/** Write one asset file into a fresh directory and return its path. */
const fileAt = async (name, contents) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ove-serve-'))
  const file = path.join(directory, name)
  if (contents !== undefined) await writeFile(file, contents, 'utf8')
  return file
}

const call = async (handler, method = 'GET') => {
  const response = makeResponse()
  await handler({ method }, response)
  return response
}

/** One request double that streams the given chunks. */
const requestWith = (chunks) => (async function* stream() {
  for (const chunk of chunks) yield chunk
}())

/* ------------------------------------------------------------------ */
/* Stylesheet route                                                    */
/* ------------------------------------------------------------------ */

test('the stylesheet is served uncached as CSS', async () => {
  const file = await fileAt('style.css', '.ove-tab { color: red; }\n')
  const warnings = []
  const response = await call(createStyleHandler({ file, warn: message => warnings.push(message) }))

  assert.equal(response.status, 200)
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.equal(response.headers['content-type'], 'text/css; charset=utf-8')
  assert.equal(response.headers['content-disposition'], 'inline')
  assert.equal(response.body, '.ove-tab { color: red; }\n')
  assert.deepEqual(warnings, [])
})

test('a rewritten stylesheet is visible without a restart', async () => {
  const file = await fileAt('style.css', '.ove-tab { color: red; }\n')
  const handler = createStyleHandler({ file, warn: () => undefined })
  assert.match((await call(handler)).body, /red/)

  await writeFile(file, '.ove-tab { color: green; }\n', 'utf8')
  assert.match((await call(handler)).body, /green/)
})

test('HEAD answers with the headers but no body', async () => {
  const file = await fileAt('style.css', '.ove-tab { color: red; }\n')
  const response = await call(createStyleHandler({ file, warn: () => undefined }), 'HEAD')
  assert.equal(response.status, 200)
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.equal(response.body, '')
})

test('a missing stylesheet is a 500 that names the file', async () => {
  const file = await fileAt('style.css', undefined)
  const warnings = []
  const response = await call(createStyleHandler({ file, warn: message => warnings.push(message) }))
  assert.equal(response.status, 500)
  assert.match(response.body, /css\/style\.css/)
  assert.equal(warnings.length, 1)
})

test('only GET and HEAD reach the asset', async () => {
  const file = await fileAt('style.css', '.ove-tab { color: red; }\n')
  const response = await call(createStyleHandler({ file, warn: () => undefined }), 'POST')
  assert.equal(response.status, 405)
})

/* ------------------------------------------------------------------ */
/* Language route                                                      */
/* ------------------------------------------------------------------ */

test('the catalogue is served uncached as JSON', async () => {
  const file = await fileAt('lang.json', JSON.stringify({ zh: { 'auto.panel': '自动化增强' }, en: { 'auto.panel': 'Automation enhancements' } }))
  const warnings = []
  const response = await call(createLangHandler({ file, warn: message => warnings.push(message) }))

  assert.equal(response.status, 200)
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.equal(response.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(response.headers['content-disposition'], 'inline')
  const payload = JSON.parse(response.body)
  assert.equal(payload.zh['auto.panel'], '自动化增强')
  assert.equal(payload.en['auto.panel'], 'Automation enhancements')
  assert.deepEqual(warnings, [])
})

test('a rewritten catalogue is visible without a restart', async () => {
  const file = await fileAt('lang.json', JSON.stringify({ zh: { 'auto.panel': '旧' }, en: {} }))
  const handler = createLangHandler({ file, warn: () => undefined })
  assert.equal(JSON.parse((await call(handler)).body).zh['auto.panel'], '旧')

  await writeFile(file, JSON.stringify({ zh: { 'auto.panel': '新' }, en: {} }), 'utf8')
  assert.equal(JSON.parse((await call(handler)).body).zh['auto.panel'], '新')
})

test('a missing catalogue is a 500 with a code the client can read', async () => {
  const file = await fileAt('lang.json', undefined)
  const warnings = []
  const response = await call(createLangHandler({ file, warn: message => warnings.push(message) }))
  assert.equal(response.status, 500)
  assert.equal(JSON.parse(response.body).error.code, 'catalogue-unreadable')
  assert.equal(warnings.length, 1)
})

test('malformed JSON is reported, not shipped', async () => {
  const file = await fileAt('lang.json', '{ "zh": { "auto.panel": ')
  const warnings = []
  const response = await call(createLangHandler({ file, warn: message => warnings.push(message) }))
  assert.equal(response.status, 500)
  assert.equal(JSON.parse(response.body).error.code, 'catalogue-invalid')
  assert.match(warnings[0], /not valid JSON/)
})

test('a body that is not a catalogue object is rejected', async () => {
  const file = await fileAt('lang.json', '[1, 2, 3]')
  const response = await call(createLangHandler({ file, warn: () => undefined }))
  assert.equal(response.status, 500)
  assert.equal(JSON.parse(response.body).error.code, 'catalogue-invalid')
})

test('the catalogue route rejects other methods with its own code', async () => {
  const file = await fileAt('lang.json', JSON.stringify({ zh: {}, en: {} }))
  const response = await call(createLangHandler({ file, warn: () => undefined }), 'POST')
  assert.equal(response.status, 405)
  assert.equal(JSON.parse(response.body).error.code, 'method-not-allowed')
})

/* ------------------------------------------------------------------ */
/* JSON request reader                                                 */
/* ------------------------------------------------------------------ */

test('the JSON reader parses one bounded body', async () => {
  const body = await readJsonBody(requestWith([Buffer.from('{"a":'), Buffer.from('1}')]))
  assert.deepEqual(body, { a: 1 })
})

test('the JSON reader refuses a body past the bound', async () => {
  await assert.rejects(
    () => readJsonBody(requestWith([Buffer.alloc(MAX_REQUEST_BYTES + 1)])),
    /request-too-large/,
  )
})

test('the reader takes a larger bound where a route allows it', async () => {
  const wide = Buffer.alloc(MAX_REQUEST_BYTES * 2, 0x20)
  await assert.rejects(() => readJsonBody(requestWith([wide])), /request-too-large/)
  // 24 KB is right at the 32 KB limit the automation routes use.
  const payload = Buffer.from(JSON.stringify({ filler: 'x'.repeat(24 * 1024) }))
  assert.equal((await readJsonBody(requestWith([payload]), 32 * 1024)).filler.length, 24 * 1024)
})

test('an empty body is an error unless the route opts into a value', async () => {
  await assert.rejects(() => readJsonBody(requestWith([])))
  assert.deepEqual(await readJsonBody(requestWith([]), MAX_REQUEST_BYTES, { empty: {} }), {})
})
