// Tests for the popup entrance motion and the undo countdown wording.
//
// The plugin's dialogs, undo receipts and in-page windows animate in with a
// blur that resolves into a small spring, and one switch on the plugin page
// turns that off for all of them. The deletion receipt used to say
// "undo within N seconds"; it now shows the bare remaining seconds. These
// cases pin the flag, the root class, the stylesheet hooks and the wording.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const clientSource = await readFile(new URL('client.js', root), 'utf8')
const stylesheet = await readFile(new URL('css/style.css', root), 'utf8')
const catalogue = JSON.parse(await readFile(new URL('locale/lang.json', root), 'utf8'))

/** Run the shipped flag store against a fresh in-memory localStorage. */
const flagsWith = (seed) => {
  const start = clientSource.indexOf('    const FLAGS_KEY = ')
  const end = clientSource.indexOf('    /* Subagent tree settings')
  assert.ok(start >= 0 && end > start, 'missing flag-store anchors')
  const storage = new Map(Object.entries(seed).map(([key, value]) => [key, JSON.stringify(value)]))
  const localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => { storage.set(key, String(value)) },
    removeItem: (key) => { storage.delete(key) },
  }
  const factory = new Function(
    'globalThis', 'localStorage', 'React',
    `${clientSource.slice(start, end)}

return { DEFAULT_FLAGS, readFlags, getFlags, setFlag }`,
  )
  return factory({ localStorage }, localStorage, { useSyncExternalStore: () => undefined })
}

test('popup motion is on for a profile that never touched the page', () => {
  const flags = flagsWith({})
  assert.equal(flags.DEFAULT_FLAGS.motion, true)
  assert.equal(flags.getFlags().motion, true)
})

test('only an explicit false turns popup motion off', () => {
  const key = 'original-version-enhancements.flags.v1'
  assert.equal(flagsWith({ [key]: { motion: false } }).getFlags().motion, false)
  assert.equal(flagsWith({ [key]: { motion: true } }).getFlags().motion, true)
  // Anything unreadable falls back to the default instead of hiding the motion.
  assert.equal(flagsWith({ [key]: { motion: 'no' } }).getFlags().motion, true)
})

test('the settings page shows the motion switch as the last box', () => {
  const settings = clientSource.slice(
    clientSource.indexOf('function PluginPage('),
    clientSource.indexOf('/* Archived sessions page'),
  )
  const motion = settings.indexOf("feature('switch.motion', flags.motion, () => toggle('motion'), null)")
  assert.ok(motion > 0, 'the motion box is not registered on the plugin page')
  const subagent = settings.indexOf('h(SubagentTreeSettingsRows')
  const groupEnd = settings.indexOf("h('p', { className: 'ove-hint' }")
  assert.ok(subagent > 0 && groupEnd > subagent)
  // New features append downward: the motion box must come after every older
  // box, including the subagent rows.
  assert.ok(motion > subagent && motion < groupEnd, 'the motion box must be last')
})

test('the switch toggles one class on the document root', () => {
  assert.match(
    clientSource,
    /ctx\.effect\(\(\) => \{\n\s+const root = globalThis\.document\?\.documentElement;[\s\S]*?root\.classList\.toggle\('ove-motion-off', !motion\);[\s\S]*?\}, 'original-version-enhancements: entrance motion switch'\);/u,
  )
  // The class follows the flag, not just the initial read.
  const effect = clientSource.slice(
    clientSource.indexOf("'original-version-enhancements: entrance motion switch'") - 900,
    clientSource.indexOf("'original-version-enhancements: entrance motion switch'"),
  )
  assert.match(effect, /subscribeFlags\(sync\)/u)
  assert.match(effect, /root\.classList\.remove\('ove-motion-off'\)/u)
})

test('the stylesheet animates every popup surface', () => {
  for (const name of ['ove-overlay-in', 'ove-dialog-jelly', 'ove-toast-jelly', 'ove-panel-jelly']) {
    assert.match(stylesheet, new RegExp(`@keyframes ${name} \\{`, 'u'), `missing ${name}`)
  }
  // Progressive blur on the backdrop and on the card itself.
  assert.match(stylesheet, /@keyframes ove-overlay-in \{\n\s+from \{[^}]*blur\(0px\)[^}]*\}\n\s+to \{[^}]*blur\(6px\)[^}]*\}/u)
  assert.match(stylesheet, /@keyframes ove-dialog-jelly \{\n\s+0% \{[^}]*filter: blur\(10px\)[^}]*\}/u)
  // Each surface carries its entrance animation.
  assert.match(stylesheet, /\.ove-overlay \{[^}]*animation: ove-overlay-in/u)
  assert.match(stylesheet, /\.ove-dialog \{[^}]*animation: ove-dialog-jelly/u)
  assert.match(stylesheet, /\.ove-toast \{[^}]*animation: ove-toast-jelly/u)
  assert.match(stylesheet, /\.ove-detached-toast \{[^}]*animation: ove-toast-jelly/u)
  assert.match(stylesheet, /\.ove-detached-panel \{[^}]*animation: ove-panel-jelly/u)
})

test('one class and the OS preference both silence the entrances', () => {
  const media = stylesheet.slice(
    stylesheet.indexOf('@media (prefers-reduced-motion: reduce) {'),
    stylesheet.indexOf('@media (max-width: 640px)'),
  )
  assert.match(media, /animation: none !important;/u)
  for (const surface of ['ove-overlay', 'ove-dialog', 'ove-toast', 'ove-detached-toast', 'ove-detached-panel']) {
    assert.ok(
      stylesheet.includes(`html.ove-motion-off .${surface}`),
      `the motion switch does not cover .${surface}`,
    )
    assert.ok(
      media.includes(`.${surface}`),
      `reduced motion does not cover .${surface}`,
    )
  }
})

test('the undo countdown shows the bare remaining seconds', () => {
  assert.equal(catalogue.zh.deleteUndoSeconds, '{n} 秒')
  assert.equal(catalogue.en.deleteUndoSeconds, '{n}s')
  for (const language of ['zh', 'en']) {
    assert.doesNotMatch(catalogue[language].deleteUndoSeconds, /内可撤销|Undo within|within/u)
    assert.match(catalogue[language].deleteUndoSeconds, /\{n\}/u)
  }
  // The receipt still feeds the countdown text through that key.
  assert.match(clientSource, /tr\('deleteUndoSeconds'\)\.replace\('\{n\}', String\(remaining\)\)/u)
})

test('the motion switch is translated in both languages', () => {
  for (const language of ['zh', 'en']) {
    assert.ok(catalogue[language]['switch.motion'].length > 0)
    assert.ok(catalogue[language]['switch.motion.desc'].length > 0)
    assert.doesNotMatch(catalogue[language]['switch.motion.desc'], /\{\w+\}/u)
  }
})
