// Tests for the popup entrance motion and the undo countdown wording.
//
// The plugin's dialogs, undo receipts and in-page windows animate in with a
// blur that resolves into a small spring, one switch on the plugin page turns
// that off for all of them, and the rows under that switch pick one of several
// entrance styles. The deletion receipt used to say "undo within N seconds";
// it now shows the bare remaining seconds. These cases pin the flag, the style
// store, the root classes, the stylesheet hooks and the wording.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const clientSource = await readFile(new URL('client.js', root), 'utf8')
const stylesheet = await readFile(new URL('css/style.css', root), 'utf8')
const catalogue = JSON.parse(await readFile(new URL('locale/lang.json', root), 'utf8'))

/** A fresh in-memory localStorage shared by the store harnesses. */
const storageWith = (seed) => {
  const storage = new Map(Object.entries(seed).map(([key, value]) => [key, JSON.stringify(value)]))
  const localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => { storage.set(key, String(value)) },
    removeItem: (key) => { storage.delete(key) },
  }
  return { storage, localStorage }
}

/** Run the shipped flag store against a fresh in-memory localStorage. */
const flagsWith = (seed) => {
  const start = clientSource.indexOf('    const FLAGS_KEY = ')
  const end = clientSource.indexOf('    /* Subagent tree settings')
  assert.ok(start >= 0 && end > start, 'missing flag-store anchors')
  const { localStorage } = storageWith(seed)
  const factory = new Function(
    'globalThis', 'localStorage', 'React',
    `${clientSource.slice(start, end)}

return { DEFAULT_FLAGS, readFlags, getFlags, setFlag }`,
  )
  return factory({ localStorage }, localStorage, { useSyncExternalStore: () => undefined })
}

/** Run the shipped entrance-style store against a fresh in-memory localStorage. */
const motionWith = (seed) => {
  const start = clientSource.indexOf('    const MOTION_KEY = ')
  const end = clientSource.indexOf('    /* Subagent tree settings')
  assert.ok(start >= 0 && end > start, 'missing motion-store anchors')
  const { storage, localStorage } = storageWith(seed)
  const factory = new Function(
    'globalThis', 'localStorage', 'React',
    `${clientSource.slice(start, end)}

return { MOTION_STYLES, DEFAULT_MOTION, readMotion, getMotion, setMotion }`,
  )
  return { ...factory({ localStorage }, localStorage, { useSyncExternalStore: () => undefined }), storage }
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

test('the entrance style defaults to jelly and rejects unknown picks', () => {
  const motion = motionWith({})
  assert.deepEqual(motion.MOTION_STYLES, ['jelly', 'soft', 'slide', 'snap'])
  assert.equal(motion.getMotion().style, 'jelly')

  const key = 'original-version-enhancements.motion.v1'
  assert.equal(motionWith({ [key]: { style: 'slide' } }).getMotion().style, 'slide')
  assert.equal(motionWith({ [key]: { style: 'wobble' } }).getMotion().style, 'jelly')
  assert.equal(motionWith({ [key]: 'nonsense' }).getMotion().style, 'jelly')
})

test('picking a style stores it and ignores a stale key', () => {
  const motion = motionWith({})
  motion.setMotion({ style: 'soft' })
  assert.equal(motion.getMotion().style, 'soft')
  assert.deepEqual(JSON.parse(motion.storage.get('original-version-enhancements.motion.v1')), { style: 'soft' })
  // An unknown value keeps the current pick instead of resetting the store.
  motion.setMotion({ style: 'nope' })
  assert.equal(motion.getMotion().style, 'soft')
})

test('the settings page shows the motion switch as the last box', () => {
  const settings = clientSource.slice(
    clientSource.indexOf('function PluginPage('),
    clientSource.indexOf('/* Archived sessions page'),
  )
  const motion = settings.indexOf("feature('switch.motion', flags.motion, () => toggle('motion'),")
  assert.ok(motion > 0, 'the motion box is not registered on the plugin page')
  const subagent = settings.indexOf('h(SubagentTreeSettingsRows')
  const groupEnd = settings.indexOf("h('p', { className: 'ove-hint' }")
  assert.ok(subagent > 0 && groupEnd > subagent)
  // New features append downward: the motion box must come after every older
  // box, including the subagent rows.
  assert.ok(motion > subagent && motion < groupEnd, 'the motion box must be last')
  // Under the switch: one button per style, the active one pressed, each pick
  // written straight to the store.
  const body = settings.slice(motion, groupEnd)
  assert.match(body, /MOTION_STYLES\.map\(id => h\('button', \{/u)
  assert.match(body, /'aria-pressed': motion\.style === id/u)
  assert.match(body, /onClick: \(\) => setMotion\(\{ style: id \}\)/u)
  assert.match(body, /tr\(`motion\.\$\{id\}`\)/u)
})

test('the root classes follow both the switch and the picked style', () => {
  assert.match(
    clientSource,
    /ctx\.effect\(\(\) => \{\n\s+const root = globalThis\.document\?\.documentElement;[\s\S]*?root\.classList\.toggle\('ove-motion-off', !motion\);[\s\S]*?root\.classList\.toggle\(`ove-motion-\$\{id\}`, motion && id === style\);[\s\S]*?\}, 'original-version-enhancements: entrance motion switch'\);/u,
  )
  const label = "'original-version-enhancements: entrance motion switch'"
  const effect = clientSource.slice(clientSource.indexOf(label) - 1400, clientSource.indexOf(label))
  assert.match(effect, /subscribeFlags\(sync\)/u)
  assert.match(effect, /subscribeMotion\(sync\)/u)
  assert.match(effect, /const style = getMotion\(\)\.style;/u)
  assert.match(effect, /for \(const id of MOTION_STYLES\)/u)
  assert.match(effect, /root\.classList\.remove\('ove-motion-off'\)/u)
  assert.match(effect, /root\.classList\.remove\(`ove-motion-\$\{id\}`\)/u)
})

test('the stylesheet animates every popup surface', () => {
  for (const name of ['ove-overlay-in', 'ove-dialog-jelly', 'ove-toast-jelly', 'ove-panel-jelly']) {
    assert.match(stylesheet, new RegExp(`@keyframes ${name} \\{`, 'u'), `missing ${name}`)
  }
  // The blur is painted once (a static backdrop-filter) and only its opacity
  // fades; animating `backdrop-filter` itself re-blurs the page every frame and
  // was what made the entrance stutter.
  assert.match(stylesheet, /@keyframes ove-overlay-in \{\n\s+from \{ opacity: 0; \}\n\s+to \{ opacity: 1; \}/u)
  assert.match(stylesheet, /\.ove-overlay \{[^}]*backdrop-filter: blur\(6px\);/u)
  // Every surface carries its entrance animation.
  assert.match(stylesheet, /\.ove-overlay \{[^}]*animation: ove-overlay-in/u)
  assert.match(stylesheet, /\.ove-dialog \{[^}]*animation: ove-dialog-jelly/u)
  assert.match(stylesheet, /\.ove-toast \{[^}]*animation: ove-toast-jelly/u)
  assert.match(stylesheet, /\.ove-detached-toast \{[^}]*animation: ove-toast-jelly/u)
  assert.match(stylesheet, /\.ove-detached-panel \{[^}]*animation: ove-panel-jelly/u)
})

test('no entrance animates a filter, so the compositor owns the whole move', () => {
  /** Everything from one `{` to its matching `}`, nested rules included. */
  const blockOf = (source, at) => {
    let depth = 0
    for (let index = at; index < source.length; index += 1) {
      if (source[index] === '{') depth += 1
      else if (source[index] === '}') {
        depth -= 1
        if (depth === 0) return source.slice(at, index + 1)
      }
    }
    return source.slice(at)
  }
  for (const name of ['ove-overlay-in', 'ove-dialog-jelly', 'ove-toast-jelly', 'ove-panel-jelly']) {
    const at = stylesheet.indexOf(`@keyframes ${name} {`)
    assert.ok(at >= 0, `missing ${name}`)
    assert.doesNotMatch(blockOf(stylesheet, at), /filter/u, `${name} still animates a filter`)
  }
  // Animated backdrop-filter was the expensive part of the first version.
  const overlayAt = stylesheet.indexOf('@keyframes ove-overlay-in {')
  assert.doesNotMatch(blockOf(stylesheet, overlayAt), /backdrop-filter/u)
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

test('every pickable style overrides all four surfaces', () => {
  const styles = stylesheet.slice(stylesheet.indexOf('Alternate entrance styles'))
  for (const id of ['soft', 'slide', 'snap']) {
    assert.match(styles, new RegExp(`@keyframes ove-dialog-${id} \\{`, 'u'), `missing ove-dialog-${id}`)
    for (const surface of ['ove-dialog', 'ove-toast', 'ove-detached-toast', 'ove-detached-panel']) {
      assert.ok(
        styles.includes(`html.ove-motion-${id} .${surface}`),
        `style ${id} does not override .${surface}`,
      )
    }
    assert.ok(
      styles.includes(`html.ove-motion-${id} .ove-overlay { animation-duration:`),
      `style ${id} does not adjust the overlay timing`,
    )
  }
  // Jelly is the base stylesheet, so it needs no override block of its own.
  assert.doesNotMatch(styles, /html\.ove-motion-jelly/u)
})

test('the alternate styles keep the compositor contract', () => {
  const blockOf = (source, at) => {
    let depth = 0
    for (let index = at; index < source.length; index += 1) {
      if (source[index] === '{') depth += 1
      else if (source[index] === '}') {
        depth -= 1
        if (depth === 0) return source.slice(at, index + 1)
      }
    }
    return source.slice(at)
  }
  for (const name of [
    'ove-dialog-soft', 'ove-toast-soft', 'ove-panel-soft',
    'ove-dialog-slide', 'ove-toast-slide', 'ove-panel-slide',
    'ove-dialog-snap', 'ove-toast-snap', 'ove-panel-snap',
  ]) {
    const at = stylesheet.indexOf(`@keyframes ${name} {`)
    assert.ok(at >= 0, `missing ${name}`)
    assert.doesNotMatch(blockOf(stylesheet, at), /filter/u, `${name} animates a filter`)
  }
})

test('the two middle styles cannot be mistaken for each other', () => {
  /** Everything from one `{` to its matching `}`, nested rules included. */
  const blockOf = (source, at) => {
    let depth = 0
    for (let index = at; index < source.length; index += 1) {
      if (source[index] === '{') depth += 1
      else if (source[index] === '}') {
        depth -= 1
        if (depth === 0) return source.slice(at, index + 1)
      }
    }
    return source.slice(at)
  }
  const keyframes = (name) => blockOf(stylesheet, stylesheet.indexOf(`@keyframes ${name} {`))
  // Soft fade: opacity only, so it stays a cross-fade in place.
  for (const name of ['ove-dialog-soft', 'ove-toast-soft']) {
    const block = keyframes(name)
    assert.doesNotMatch(block, /transform|translate|scale/u, `${name} moved: it must be a pure fade`)
    assert.match(block, /opacity/u)
  }
  // Slide up: a clear travel from below, far enough to read as movement.
  assert.match(keyframes('ove-dialog-slide'), /transform: translateY\(44px\)/u)
  assert.match(keyframes('ove-toast-slide'), /translate\(-50%, -28px\)/u)
  assert.match(keyframes('ove-panel-slide'), /translate: 0 30px/u)
})

test('the four style chips are black, not brand blue', () => {
  assert.match(
    stylesheet,
    /\.ove-motion-styles \.ove-size\.is-on \{\n\s+background: var\(--dsw-alias-label-primary\);\n\s+border-color: var\(--dsw-alias-label-primary\);\n\s+color: var\(--dsw-alias-bg-base\);/u,
  )
  // The settings page puts the modifier on that group, so the shared `.ove-size`
  // styling (brand blue elsewhere) is left alone.
  assert.match(clientSource, /className: 'ove-size-group ove-motion-styles'/u)
})


test('every style has a name in both languages', () => {
  for (const language of ['zh', 'en']) {
    for (const key of ['motion.style', 'motion.style.desc', 'motion.jelly', 'motion.soft', 'motion.slide', 'motion.snap']) {
      assert.ok(Object.hasOwn(catalogue[language], key), `${language} is missing ${key}`)
      assert.ok(catalogue[language][key].trim().length > 0, `${language}.${key} is empty`)
    }
    assert.doesNotMatch(catalogue[language]['motion.style.desc'], /\{\w+\}/u)
    const names = ['jelly', 'soft', 'slide', 'snap'].map(id => catalogue[language][`motion.${id}`])
    assert.equal(new Set(names).size, names.length, `${language} style names are not distinct`)
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
