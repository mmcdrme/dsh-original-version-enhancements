// Unit tests for the remembered fold state of the plugin's settings page.
//
// The store lives inside client.js's module closure, so the cases slice the
// shipped source text and evaluate it against a stub localStorage. Only the
// unfolded boxes are stored: a profile that never touched the page must open
// every box folded.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8')

/** Run the real store against a fresh in-memory localStorage. */
const storeWith = (seed) => {
  const start = clientSource.indexOf('    const SETTINGS_OPEN_KEY = ')
  const end = clientSource.indexOf('    /**\n     * One "big setting" box:')
  assert.ok(start >= 0 && end > start, 'missing settings-fold anchors')
  const storage = new Map(Object.entries(seed))
  const localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => { storage.set(key, String(value)) },
    removeItem: (key) => { storage.delete(key) },
  }
  const sink = {}
  const factory = new Function('globalThis', 'localStorage', 'React', `${clientSource.slice(start, end)}
return { SETTINGS_OPEN_KEY, readSettingsOpen, setSettingOpen, getSettingsOpen }`)
  return { ...factory({ localStorage }, localStorage, { useSyncExternalStore: () => undefined }), storage }
}

test('the key carries the unfolded set, not the folded one', () => {
  const store = storeWith({})
  assert.equal(store.SETTINGS_OPEN_KEY, 'original-version-enhancements.settings-open.v2')
})

test('a profile that never touched the page has every box folded', () => {
  const store = storeWith({})
  assert.deepEqual(store.readSettingsOpen(), {})
})

test('the old folded-key format does not reopen anything', () => {
  const store = storeWith({ 'original-version-enhancements.settings-open.v2': JSON.stringify({ 'switch.recall': false }) })
  assert.deepEqual(store.readSettingsOpen(), {})
})

test('unfolding a box stores it and folding it drops the entry', () => {
  const store = storeWith({})
  store.setSettingOpen('switch.recall', true)
  assert.deepEqual(store.getSettingsOpen(), { 'switch.recall': true })
  assert.equal(JSON.parse(store.storage.get(store.SETTINGS_OPEN_KEY))['switch.recall'], true)

  store.setSettingOpen('switch.recall', false)
  assert.deepEqual(store.getSettingsOpen(), {})
  assert.deepEqual(JSON.parse(store.storage.get(store.SETTINGS_OPEN_KEY)), {})
})

test('each box remembers its own state', () => {
  const store = storeWith({})
  store.setSettingOpen('switch.recall', true)
  store.setSettingOpen('switch.detached', true)
  store.setSettingOpen('switch.recall', false)
  assert.deepEqual(JSON.parse(store.storage.get(store.SETTINGS_OPEN_KEY)), { 'switch.detached': true })
})

test('a malformed record falls back to the fully folded page', () => {
  for (const raw of ['null', '"x"', '[]', '42']) {
    const store = storeWith({ 'original-version-enhancements.settings-open.v2': raw })
    assert.deepEqual(store.readSettingsOpen(), {})
  }
})
