// Guards for the shipped language catalogue.
//
// The page, the menus and the dialogs take their wording from
// `locale/lang.json`, which is edited by hand; these cases keep the two
// catalogues in step and catch a key the source asks for but nobody translated.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const catalogue = JSON.parse(await readFile(new URL('locale/lang.json', root), 'utf8'))
const clientSource = await readFile(new URL('client.js', root), 'utf8')

test('both catalogues carry the same keys', () => {
  const zh = Object.keys(catalogue.zh).sort()
  const en = Object.keys(catalogue.en).sort()
  assert.deepEqual(en, zh)
  assert.ok(zh.length > 300, `expected a full catalogue, got ${zh.length} keys`)
})

test('no entry is empty in either language', () => {
  for (const language of ['zh', 'en']) {
    for (const [key, value] of Object.entries(catalogue[language])) {
      assert.equal(typeof value, 'string', `${language}.${key} is not a string`)
      assert.ok(value.trim().length > 0, `${language}.${key} is empty`)
    }
  }
})

test('placeholders agree between the two languages', () => {
  const holders = (text) => [...text.matchAll(/\{(\w+)\}/gu)].map((match) => match[1]).sort()
  for (const key of Object.keys(catalogue.zh)) {
    assert.deepEqual(holders(catalogue.en[key]), holders(catalogue.zh[key]), `placeholder mismatch at ${key}`)
  }
})

test('the recall mode row headlines the mode that is on', () => {
  for (const language of ['zh', 'en']) {
    assert.ok(catalogue[language]['recall.mode.independent'].length > 0)
    assert.ok(catalogue[language]['recall.mode.shared'].length > 0)
    // The sub-line explains both modes, so it carries no placeholder.
    assert.doesNotMatch(catalogue[language]['recall.scope.desc'], /\{\w+\}/u)
  }
  assert.match(
    clientSource,
    /tr\(recall\.perSession === true \? 'recall\.mode\.independent' : 'recall\.mode\.shared'\)/u,
  )
  assert.doesNotMatch(clientSource, /tr\('recall\.scope\.desc'\)\.replace/u)
})

test('every literal key the client asks for exists in both languages', () => {
  const keys = new Set([...clientSource.matchAll(/\btr\('([^']+)'\)/gu)].map((match) => match[1]))
  assert.ok(keys.size > 100, `expected many translated keys, got ${keys.size}`)
  for (const key of keys) {
    assert.ok(Object.hasOwn(catalogue.zh, key), `zh catalogue is missing ${key}`)
    assert.ok(Object.hasOwn(catalogue.en, key), `en catalogue is missing ${key}`)
  }
})
