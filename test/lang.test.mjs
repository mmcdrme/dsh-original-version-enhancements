// Regression tests for the language-catalogue route.
//
// The wording ships as `locale/lang.json` and the Host reads it on every
// request with `no-store`, which is what makes "edit the JSON, refresh the page"
// work without a rebuild. These tests pin that contract: a good file is served
// verbatim (as JSON), and a missing or malformed file is reported instead of
// being answered with a body the client cannot parse.

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const moduleUrl = new URL('../host/lang.mjs', import.meta.url)
const { createLangHandler } = await import(moduleUrl)

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

/** Write one catalogue file into a fresh directory and return its path. */
const catalogueAt = async (contents) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ove-lang-'))
  const file = path.join(directory, 'lang.json')
  if (contents !== undefined) await writeFile(file, contents, 'utf8')
  return file
}

const call = async (handler, method = 'GET') => {
  const response = makeResponse()
  await handler({ method }, response)
  return response
}

test('serves the current file, uncached, as JSON', async () => {
  const file = await catalogueAt(JSON.stringify({ zh: { 'auto.panel': '自动化增强' }, en: { 'auto.panel': 'Automation enhancements' } }))
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

test('a second request sees the rewritten file without any restart', async () => {
  const file = await catalogueAt(JSON.stringify({ zh: { 'auto.panel': '旧' }, en: {} }))
  const handler = createLangHandler({ file, warn: () => undefined })
  const first = JSON.parse((await call(handler)).body)
  assert.equal(first.zh['auto.panel'], '旧')

  await writeFile(file, JSON.stringify({ zh: { 'auto.panel': '新' }, en: {} }), 'utf8')
  const second = JSON.parse((await call(handler)).body)
  assert.equal(second.zh['auto.panel'], '新')
})

test('HEAD answers with the headers but no body', async () => {
  const file = await catalogueAt(JSON.stringify({ zh: {}, en: {} }))
  const response = await call(createLangHandler({ file, warn: () => undefined }), 'HEAD')
  assert.equal(response.status, 200)
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.equal(response.body, '')
})

test('a missing file is a 500 that names the problem', async () => {
  const file = await catalogueAt(undefined)
  const warnings = []
  const response = await call(createLangHandler({ file, warn: message => warnings.push(message) }))
  assert.equal(response.status, 500)
  assert.equal(JSON.parse(response.body).error.code, 'catalogue-unreadable')
  assert.equal(warnings.length, 1)
})

test('malformed JSON is reported, not shipped', async () => {
  const file = await catalogueAt('{ "zh": { "auto.panel": ')
  const warnings = []
  const response = await call(createLangHandler({ file, warn: message => warnings.push(message) }))
  assert.equal(response.status, 500)
  assert.equal(JSON.parse(response.body).error.code, 'catalogue-invalid')
  assert.match(warnings[0], /not valid JSON/)
})

test('a body that is not a catalogue object is rejected', async () => {
  const file = await catalogueAt('[1, 2, 3]')
  const response = await call(createLangHandler({ file, warn: () => undefined }))
  assert.equal(response.status, 500)
  assert.equal(JSON.parse(response.body).error.code, 'catalogue-invalid')
})

test('only GET and HEAD are accepted', async () => {
  const file = await catalogueAt(JSON.stringify({ zh: {}, en: {} }))
  const response = await call(createLangHandler({ file, warn: () => undefined }), 'POST')
  assert.equal(response.status, 405)
  assert.equal(JSON.parse(response.body).error.code, 'method-not-allowed')
})
