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

return { MOTION_STYLES, MOTION_EXITS, DEFAULT_MOTION, readMotion, getMotion, setMotion }`,
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
  assert.deepEqual(motion.MOTION_STYLES, ['jelly', 'soft', 'slide', 'snap', 'drift', 'drop', 'zoom', 'flip'])
  assert.equal(motion.getMotion().style, 'jelly')
  // The backdrop blur is an independent setting, on by default.
  assert.equal(motion.getMotion().blur, true)
  // So are the closing motion, its style and the undo-receipt motion.
  assert.equal(motion.getMotion().close, true)
  assert.equal(motion.getMotion().exit, 'fade')
  assert.equal(motion.getMotion().toast, true)
  assert.equal(motion.getMotion().toastExit, 'fade')
  assert.deepEqual(motion.MOTION_EXITS, ['fade', 'ghost', 'sink', 'shrink'])

  const key = 'original-version-enhancements.motion.v1'
  assert.equal(motionWith({ [key]: { style: 'slide' } }).getMotion().style, 'slide')
  assert.equal(motionWith({ [key]: { style: 'flip' } }).getMotion().style, 'flip')
  assert.equal(motionWith({ [key]: { style: 'wobble' } }).getMotion().style, 'jelly')
  assert.equal(motionWith({ [key]: 'nonsense' }).getMotion().style, 'jelly')
  assert.equal(motionWith({ [key]: { exit: 'shrink' } }).getMotion().exit, 'shrink')
  assert.equal(motionWith({ [key]: { exit: 'pop' } }).getMotion().exit, 'fade')
  assert.equal(motionWith({ [key]: { toastExit: 'ghost' } }).getMotion().toastExit, 'ghost')
  assert.equal(motionWith({ [key]: { toastExit: 'pop' } }).getMotion().toastExit, 'fade')
})

test('closing motion and receipt motion have their own stored switches', () => {
  const key = 'original-version-enhancements.motion.v1'
  // An older record that predates these switches keeps both on.
  const before = motionWith({ [key]: { style: 'snap' } }).getMotion()
  assert.equal(before.close, true)
  assert.equal(before.toast, true)

  assert.equal(motionWith({ [key]: { close: false } }).getMotion().close, false)
  assert.equal(motionWith({ [key]: { toast: false } }).getMotion().toast, false)

  const motion = motionWith({})
  motion.setMotion({ close: false })
  assert.equal(motion.getMotion().close, false)
  assert.equal(motion.getMotion().toast, true, 'the close switch must not touch the receipt switch')
  motion.setMotion({ toast: false })
  assert.equal(motion.getMotion().toast, false)
  motion.setMotion({ exit: 'ghost' })
  assert.equal(motion.getMotion().exit, 'ghost')
  assert.equal(motion.getMotion().close, false, 'picking an exit must not turn closing back on')
  motion.setMotion({ exit: 'nope' })
  assert.equal(motion.getMotion().exit, 'ghost', 'an unknown exit keeps the current pick')
  // The receipt has its own pick, apart from the dialog's.
  motion.setMotion({ toastExit: 'sink' })
  assert.equal(motion.getMotion().toastExit, 'sink')
  assert.equal(motion.getMotion().exit, 'ghost', 'picking the receipt exit must not move the dialog exit')
  motion.setMotion({ toastExit: 'nope' })
  assert.equal(motion.getMotion().toastExit, 'sink', 'an unknown receipt exit keeps the current pick')
})

test('the blur has its own stored switch, apart from the style', () => {
  const key = 'original-version-enhancements.motion.v1'
  assert.equal(motionWith({ [key]: { style: 'snap', blur: false } }).getMotion().blur, false)
  assert.equal(motionWith({ [key]: { style: 'snap', blur: true } }).getMotion().blur, true)
  // An old record that predates the switch keeps the blur on.
  assert.equal(motionWith({ [key]: { style: 'snap' } }).getMotion().blur, true)

  const motion = motionWith({})
  motion.setMotion({ blur: false })
  assert.equal(motion.getMotion().style, 'jelly', 'turning the blur off must not change the style')
  assert.equal(motion.getMotion().blur, false)
  motion.setMotion({ style: 'slide' })
  assert.equal(motion.getMotion().blur, false, 'picking a style must not turn the blur back on')
})

test('picking a style stores it and ignores a stale key', () => {
  const motion = motionWith({})
  motion.setMotion({ style: 'soft' })
  assert.equal(motion.getMotion().style, 'soft')
  assert.deepEqual(
    JSON.parse(motion.storage.get('original-version-enhancements.motion.v1')),
    { style: 'soft', blur: true, close: true, exit: 'fade', toast: true, toastExit: 'fade' },
  )
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
  // And its own switch for the backdrop blur, beneath the style chips.
  assert.match(body, /settingRow\(tr\('motion\.blur'\), tr\('motion\.blur\.desc'\), switchOf\(/u)
  assert.match(body, /setMotion\(\{ blur: motion\.blur === false \}\)/u)
  // The second row of switches: closing motion, its exit picks and the undo
  // receipts. Each is a stored setting of its own.
  assert.match(body, /settingRow\(tr\('motion\.close'\), tr\('motion\.close\.desc'\), switchOf\(/u)
  assert.match(body, /setMotion\(\{ close: motion\.close === false \}\)/u)
  assert.match(body, /MOTION_EXITS\.map\(id => h\('button', \{/u)
  assert.match(body, /setMotion\(\{ exit: id \}\)/u)
  // The exit chips lock while closing motion is off.
  assert.match(body, /disabled: motion\.close === false/u)
  assert.match(body, /settingRow\(tr\('motion\.toast'\), tr\('motion\.toast\.desc'\), switchOf\(/u)
  assert.match(body, /setMotion\(\{ toast: motion\.toast === false \}\)/u)
  // The receipt exit pick sits under that switch and locks with it.
  assert.match(body, /settingRow\(tr\('motion\.toastExit'\), tr\('motion\.toastExit\.desc'\)/u)
  assert.match(body, /setMotion\(\{ toastExit: id \}\)/u)
  assert.match(body, /disabled: motion\.toast === false/u)
})

test('the root classes follow both the switch and the picked style', () => {
  assert.match(
    clientSource,
    /ctx\.effect\(\(\) => \{\n\s+const root = globalThis\.document\?\.documentElement;[\s\S]*?root\.classList\.toggle\('ove-motion-off', !motion\);[\s\S]*?root\.classList\.toggle\('ove-blur-off', !blur\);[\s\S]*?root\.classList\.toggle\(`ove-motion-\$\{id\}`, motion && id === style\);[\s\S]*?\}, 'original-version-enhancements: entrance motion switch'\);/u,
  )
  const label = "'original-version-enhancements: entrance motion switch'"
  const effect = clientSource.slice(clientSource.indexOf(label) - 1600, clientSource.indexOf(label))
  assert.match(effect, /subscribeFlags\(sync\)/u)
  assert.match(effect, /subscribeMotion\(sync\)/u)
  assert.match(effect, /const style = getMotion\(\)\.style;/u)
  assert.match(effect, /const blur = getMotion\(\)\.blur !== false;/u)
  assert.match(effect, /const toast = getMotion\(\)\.toast !== false;/u)
  assert.match(effect, /for \(const id of MOTION_STYLES\)/u)
  assert.match(effect, /root\.classList\.toggle\('ove-toast-motion-off', !toast\)/u)
  assert.match(effect, /root\.classList\.remove\('ove-motion-off'\)/u)
  assert.match(effect, /root\.classList\.remove\('ove-blur-off'\)/u)
  assert.match(effect, /root\.classList\.remove\('ove-toast-motion-off'\)/u)
  assert.match(effect, /root\.classList\.remove\(`ove-motion-\$\{id\}`\)/u)
})

/**
 * Run the shipped exit-motion block against a tiny fake document. It only
 * touches a handful of element members, so the fake stands in for a removed
 * popup, a receipt and an in-page window.
 */
const exitWith = (options = {}) => {
  const start = clientSource.indexOf('    const EXIT_SURFACES = ')
  const end = clientSource.indexOf('    const refreshStores = ')
  assert.ok(start >= 0 && end > start, 'missing exit-motion anchors')

  /** A stand-in element with just the members the exit block uses. */
  const element = (classes, children = []) => {
    const set = new Set(classes)
    const node = {
      nodeType: 1,
      isConnected: true,
      style: {},
      attrs: {},
      removed: false,
      tagName: '',
      children,
      classList: {
        contains: (name) => set.has(name),
        add: (...names) => { for (const name of names) set.add(name) },
        remove: (...names) => { for (const name of names) set.delete(name) },
      },
      get className() { return [...set].join(' ') },
      get classNames() { return [...set] },
      matches: (selector) => selector.split(',').some((part) => set.has(part.trim().slice(1))),
      cloneNode: () => {
        const copy = element([...set], children.map((child) => child.cloneNode()));
        copy.tagName = node.tagName;
        copy.attrs = { ...node.attrs };
        children.forEach((child, index) => { copy.children[index].parent = copy });
        return copy;
      },
      querySelectorAll: (selector) => {
        const found = [];
        for (const child of children) {
          const tag = String(child.tagName).toLowerCase();
          if (selector === 'iframe') {
            if (tag === 'iframe') found.push(child);
          } else if (tag === 'button' || tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'a') {
            found.push(child);
          }
        }
        return found;
      },
      getBoundingClientRect: () => ({ left: 40, top: 60, width: 520, height: 380 }),
      setAttribute: (name, value) => { node.attrs[name] = value },
      removeAttribute: (name) => { delete node.attrs[name] },
      remove: () => { node.removed = true },
    };
    for (const child of children) child.parent = node;
    return node;
  };

  const appended = [];
  const timers = [];
  const observerBox = { current: null };
  const body = { appendChild: (node) => { appended.push(node) } };
  const duration = options.duration ?? ((node) => (node.className.includes('ove-exit') ? 0.24 : 0));
  const globalObject = {
    document: { body },
    getComputedStyle: (node) => ({
      animationDuration: `${duration(node)}s`,
      animationDelay: '0s',
    }),
    matchMedia: () => ({ matches: options.reduce === true }),
    MutationObserver: class {
      constructor(callback) { this.callback = callback; observerBox.current = this }
      observe(target, config) { this.target = target; this.config = config }
      disconnect() { this.disconnected = true }
      emit(records) { this.callback(records) }
    },
  };
  const fakeWindow = { setTimeout: (callback, ms) => { timers.push({ callback, ms }); return timers.length } };
  const flags = { motion: options.motionFlag !== false };
  const motion = {
    style: 'jelly',
    blur: true,
    close: options.close !== false,
    exit: options.exit ?? 'fade',
    toast: options.toast !== false,
    toastExit: options.toastExit ?? 'fade',
  };
  const factory = new Function(
    'globalThis', 'window', 'getFlags', 'getMotion',
    `${clientSource.slice(start, end)}

return { EXIT_SURFACES, exitSurfaceOf, exitDurationOf, playExitMotion, watchExitMotion }`,
  );
  const api = factory(globalObject, fakeWindow, () => flags, () => motion);

  return { api, element, appended, timers, observerBox, body, duration };
};

test('the exit watcher copies a surface that left the document', () => {
  const harness = exitWith({ exit: 'fade' });
  const { api } = harness
  const cleanup = api.watchExitMotion()
  assert.equal(harness.observerBox.current.config.childList, true)
  // The in-page windows are not portalled to the body, so the watch is deep.
  assert.equal(harness.observerBox.current.config.subtree, true)
  assert.equal(harness.observerBox.current.target, harness.body)

  const dialog = harness.element(['ove-overlay', 'ove-overlay-top'])
  dialog.isConnected = false
  harness.observerBox.current.emit([{ type: 'childList', removedNodes: [dialog] }])

  assert.equal(harness.appended.length, 1, 'the departing overlay did not get a stand-in')
  const copy = harness.appended[0]
  assert.ok(copy.classNames.includes('ove-exit'), 'the copy must be marked as an exit')
  assert.ok(copy.classNames.includes('ove-exit-fade'), 'the copy must carry the picked exit')
  assert.equal(copy.attrs['aria-hidden'], 'true')
  assert.equal(copy.style.pointerEvents, 'none')
  assert.equal(copy.attrs.id, undefined)
  assert.equal(harness.timers.length, 1)
  assert.equal(harness.timers[0].ms, 280, 'the copy must live exactly as long as its exit')
  harness.timers[0].callback()
  assert.equal(copy.removed, true, 'the copy must be dropped after its exit')

  cleanup()
  assert.equal(harness.observerBox.current.disconnected, true)
})

test('a surface that was only moved is not closed', () => {
  const harness = exitWith({})
  const moved = harness.element(['ove-overlay'])
  // React re-inserts the node in the same update, so it is connected again by
  // the time the observer runs.
  moved.isConnected = true
  assert.equal(harness.api.exitSurfaceOf(moved), null)
  // The copy itself must never be watched again, or it would clone forever.
  const copy = harness.element(['ove-overlay', 'ove-exit'])
  copy.isConnected = false
  assert.equal(harness.api.exitSurfaceOf(copy), null)
  const plain = harness.element(['ove-dialog'])
  plain.isConnected = false
  assert.equal(harness.api.exitSurfaceOf(plain), null)
  const gone = harness.element(['ove-toast'])
  gone.isConnected = false
  assert.equal(harness.api.exitSurfaceOf(gone), gone)
})

test('both switches stop the exit they own', () => {
  const closeOff = exitWith({ close: false })
  const overlay = closeOff.element(['ove-overlay'])
  closeOff.api.playExitMotion(overlay)
  assert.equal(closeOff.appended.length, 0, 'closing motion is off but the dialog still played')

  const toastOff = exitWith({ toast: false })
  const receipt = toastOff.element(['ove-toast'])
  toastOff.api.playExitMotion(receipt)
  assert.equal(toastOff.appended.length, 0, 'receipt motion is off but the receipt still played')
  const dialog = toastOff.element(['ove-overlay'])
  toastOff.api.playExitMotion(dialog)
  assert.equal(toastOff.appended.length, 1, 'the receipt switch must not silence the dialogs')

  const totalOff = exitWith({ motionFlag: false })
  totalOff.api.playExitMotion(totalOff.element(['ove-overlay']))
  assert.equal(totalOff.appended.length, 0, 'the page switch is off but an exit still played')

  const reduce = exitWith({ reduce: true })
  reduce.api.playExitMotion(reduce.element(['ove-overlay']))
  assert.equal(reduce.appended.length, 0, 'reduced motion must win over the exit')
})

test('the exit shape picks the 30% ghost and drops without animation when there is none', () => {
  const ghost = exitWith({ toastExit: 'ghost', duration: (node) => (node.className.includes('ghost') ? 0.22 : 0) })
  ghost.api.playExitMotion(ghost.element(['ove-toast']))
  const copy = ghost.appended[0]
  assert.ok(copy.classNames.includes('ove-exit-ghost'))
  // Short on purpose: a dissolve, not a wait.
  assert.equal(ghost.timers[0].ms, 260)

  // Only the ghost shape stops at 30%; the other three go all the way to 0.
  const exitBlock = (name) => {
    const at = stylesheet.indexOf(`.ove-exit-${name} {`)
    assert.ok(at >= 0, `missing .ove-exit-${name}`)
    return stylesheet.slice(at, stylesheet.indexOf('}', at))
  }
  for (const id of ['fade', 'sink', 'shrink']) {
    assert.match(exitBlock(id), /--ove-exit-opacity: 0;/u, `${id} must fade out completely, not stop at 30%`)
  }
  // A ghosting receipt fades 100% -> 30% (its keyframes start at 1).
  assert.match(stylesheet, /@keyframes ove-toast-out \{\n  from \{ opacity: 1;/u)

  const still = exitWith({ duration: () => 0 })
  still.api.playExitMotion(still.element(['ove-overlay']))
  assert.equal(still.appended.length, 1)
  assert.equal(still.appended[0].removed, true, 'an unanimated copy must be dropped at once')
  assert.equal(still.timers.length, 0)
})

test('a receipt leaves by its own pick, a dialog by the closing pick', () => {
  const harness = exitWith({ exit: 'sink', toastExit: 'ghost' })
  harness.api.playExitMotion(harness.element(['ove-toast']))
  harness.api.playExitMotion(harness.element(['ove-overlay']))
  assert.ok(harness.appended[0].classNames.includes('ove-exit-ghost'), 'the receipt must carry its own exit')
  assert.ok(harness.appended[1].classNames.includes('ove-exit-sink'), 'the dialog must keep the closing pick')
})

test('the in-page window copy never carries its embedded client', () => {
  const harness = exitWith({})
  const frame = harness.element([])
  frame.tagName = 'IFRAME'
  const panel = harness.element(['ove-detached-panel'], [frame])
  panel.isConnected = false
  harness.api.playExitMotion(panel)
  const copy = harness.appended[0]
  assert.equal(copy.children[0].removed, true, 'the copy left an iframe attached: it would boot the client again')
  assert.equal(copy.style.position, 'fixed', 'the copied window must be pinned to the body')
  assert.equal(copy.style.left, '40px')
  assert.equal(copy.style.top, '60px')
  assert.equal(copy.style.width, '520px')
  // A button inside the copy must not keep its tab stop, and the live node the
  // copy came from must not be touched.
  const button = harness.element([])
  button.tagName = 'BUTTON'
  const dialog = harness.element(['ove-overlay'], [button])
  dialog.isConnected = false
  harness.api.playExitMotion(dialog)
  assert.equal(harness.appended[1].children[0].attrs.tabindex, '-1')
  assert.equal(button.attrs.tabindex, undefined)
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
  for (const id of ['soft', 'slide', 'snap', 'drift', 'drop', 'zoom', 'flip']) {
    assert.match(styles, new RegExp(`@keyframes ove-dialog-${id} \\{`, 'u'), `missing ove-dialog-${id}`)
    for (const surface of ['ove-dialog', 'ove-toast', 'ove-detached-toast', 'ove-detached-panel']) {
      assert.ok(
        styles.includes(`html.ove-motion-${id} .${surface}`),
        `style ${id} does not override .${surface}`,
      )
    }
    // Every style also adjusts the overlay's own fade; flip adds perspective
    // to the same rule, so the duration is looked for inside the block.
    const ruleAt = styles.indexOf(`html.ove-motion-${id} .ove-overlay {`)
    assert.ok(ruleAt >= 0, `style ${id} does not adjust the overlay timing`)
    const rule = styles.slice(ruleAt, styles.indexOf('}', ruleAt))
    assert.match(rule, /animation-duration:/u, `style ${id} does not set the overlay duration`)
  }
  // Jelly is the base stylesheet, so it needs no override block of its own.
  assert.doesNotMatch(styles, /html\.ove-motion-jelly/u)
})

test('the newer entrance styles each move in their own direction', () => {
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
  // Drift comes in from the side, drop from above, zoom starts too large and
  // flip tips in on the x axis: none may reuse another style's move.
  assert.match(keyframes('ove-dialog-drift'), /translateX\(44px\)/u)
  assert.match(keyframes('ove-toast-drift'), /translate\(calc\(-50% \+ 34px\), 0\)/u)
  assert.match(keyframes('ove-panel-drift'), /translate: 34px 0/u)
  assert.match(keyframes('ove-dialog-drop'), /translateY\(-38px\)/u)
  assert.match(keyframes('ove-toast-drop'), /translate\(-50%, -30px\)/u)
  assert.match(keyframes('ove-panel-drop'), /translate: 0 -28px/u)
  assert.match(keyframes('ove-dialog-zoom'), /scale\(1\.09\)/u)
  assert.match(keyframes('ove-panel-zoom'), /scale: 1\.04/u)
  assert.match(keyframes('ove-dialog-flip'), /rotateX\(-24deg\)/u)
  assert.match(keyframes('ove-panel-flip'), /perspective\(900px\) rotateX\(-20deg\)/u)
  assert.match(stylesheet, /html\.ove-motion-flip \.ove-overlay \{ perspective: 1000px;/u)
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
    'ove-dialog-drift', 'ove-toast-drift', 'ove-panel-drift',
    'ove-dialog-drop', 'ove-toast-drop', 'ove-panel-drop',
    'ove-dialog-zoom', 'ove-toast-zoom', 'ove-panel-zoom',
    'ove-dialog-flip', 'ove-toast-flip', 'ove-panel-flip',
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

test('a picked black chip keeps its fill on hover', () => {
  // The un-picked hover tint is a wash of the label colour over transparency,
  // and it is more specific than the picked fill; without this rule a black
  // chip turned almost transparent under the pointer and flashed back.
  assert.match(
    stylesheet,
    /\.ove-setting-window \.ove-size\.is-on:hover,\n\.ove-motion-styles \.ove-size\.is-on:hover,\n\.ove-setting-window \.ove-size\.is-on:focus-visible,\n\.ove-motion-styles \.ove-size\.is-on:focus-visible \{\n  background: color-mix\(in srgb, var\(--dsw-alias-label-primary\) 86%, var\(--dsw-alias-bg-base\)\);/u,
  )
  // The fill transitions instead of snapping, so the hover reads as a lift.
  assert.match(
    stylesheet,
    /\.ove-size \{[^}]*transition: background-color \.12s ease, border-color \.12s ease, color \.12s ease;/u,
  )
})

test('the motion chips are black, not brand blue', () => {
  assert.match(
    stylesheet,
    /\.ove-motion-styles \.ove-size\.is-on \{\n\s+background: var\(--dsw-alias-label-primary\);\n\s+border-color: var\(--dsw-alias-label-primary\);\n\s+color: var\(--dsw-alias-bg-base\);/u,
  )
  // The settings page puts the modifier on that group, so the shared `.ove-size`
  // styling (brand blue elsewhere) is left alone.
  assert.match(clientSource, /className: 'ove-size-group ove-motion-styles'/u)
})


test('the stylesheet plays an exit for every surface, one stopping at 30%', () => {
  for (const name of ['ove-overlay-out', 'ove-dialog-out', 'ove-toast-out', 'ove-panel-out']) {
    assert.match(stylesheet, new RegExp(`@keyframes ${name} \\{`, 'u'), `missing ${name}`)
  }
  for (const id of ['fade', 'ghost', 'sink', 'shrink']) {
    assert.ok(stylesheet.includes(`.ove-exit-${id} {`), `missing exit ${id}`)
  }
  // The copy the client leaves behind is the only thing that exits.
  assert.match(stylesheet, /\.ove-exit\.ove-overlay \{\n  animation: ove-overlay-out/u)
  assert.match(stylesheet, /\.ove-exit\.ove-overlay > \* \{ animation: none !important; \}/u)
  assert.match(stylesheet, /\.ove-exit\.ove-overlay > \.ove-dialog \{\n  animation: ove-dialog-out/u)
  assert.match(stylesheet, /\.ove-exit\.ove-toast,\n\.ove-exit\.ove-detached-toast \{\n  animation: ove-toast-out/u)
  assert.match(stylesheet, /\.ove-exit\.ove-detached-panel \{\n  animation: ove-panel-out/u)
  // The gentle exit stops at 30% opacity, never lower.
  const ghostAt = stylesheet.indexOf('.ove-exit-ghost {')
  const ghost = stylesheet.slice(ghostAt, stylesheet.indexOf('}', ghostAt))
  assert.match(ghost, /--ove-exit-opacity: \.3;/u, 'the ghost exit must stop at 30%')
  // A parent at opacity 0 would take that last 30% down with it, so the dim
  // behind a ghosting card holds instead of fading.
  assert.match(ghost, /--ove-exit-overlay-opacity: 1;/u, 'the ghost dim must hold while the card stops at 30%')
  // A ghosting exit is deliberately short: it reads as a dissolve, not a wait.
  assert.match(ghost, /--ove-exit-duration: \.22s;/u, 'the ghost exit is too slow')
  const overlayOutAt = stylesheet.indexOf('@keyframes ove-overlay-out {')
  const overlayOut = stylesheet.slice(overlayOutAt, stylesheet.indexOf('\n}', overlayOutAt))
  assert.match(overlayOut, /opacity: var\(--ove-exit-overlay-opacity, 0\);/u)
  // The watcher lives in the client and is registered as its own effect.
  assert.match(clientSource, /ctx\.effect\(\(\) => watchExitMotion\(\), 'original-version-enhancements: exit motion'\);/u)
  assert.match(
    clientSource,
    /clone\.classList\.add\('ove-exit', `ove-exit-\$\{receipt \? motion\.toastExit : motion\.exit\}`\)/u,
  )
  assert.match(clientSource, /for \(const frame of clone\.querySelectorAll\('iframe'\)\) frame\.remove\(\);/u)
})

test('the undo receipts have their own switch and press feedback', () => {
  assert.match(
    stylesheet,
    /html\.ove-toast-motion-off \.ove-toast,\nhtml\.ove-toast-motion-off \.ove-detached-toast \{ animation: none !important; \}/u,
  )
  assert.match(stylesheet, /html\.ove-toast-motion-off \.ove-toast-action:active \{ transform: none; box-shadow: none; \}/u)
  // Pressing undo dips and rings the button, which is the click's feedback.
  assert.match(stylesheet, /\.ove-toast-action:active \{ transform: scale\(\.9\); box-shadow: 0 0 0 3px rgba\(110, 231, 160, \.4\); \}/u)
  assert.match(stylesheet, /\.ove-toast-action \{ transition: transform \.12s ease, background \.14s ease, box-shadow \.16s ease; \}/u)
  assert.match(stylesheet, /\.ove-toast-warning \.ove-toast-action:active/u)
})

test('the backdrop blur has its own class, independent of the motion switch', () => {
  assert.match(
    stylesheet,
    /html\.ove-blur-off \.ove-overlay \{\n\s+backdrop-filter: none;\n\s+-webkit-backdrop-filter: none;/u,
  )
  // Turning the entrances off only stops animation: the blur switch still
  // decides whether the backdrop is blurred.
  const offAt = stylesheet.indexOf('html.ove-motion-off .ove-overlay')
  assert.ok(offAt >= 0)
  const rule = stylesheet.slice(offAt, stylesheet.indexOf('}', offAt) + 1)
  assert.doesNotMatch(rule, /backdrop-filter/u)
})

test('every style has a name in both languages', () => {
  for (const language of ['zh', 'en']) {
    for (const key of [
      'motion.style', 'motion.style.desc', 'motion.jelly', 'motion.soft', 'motion.slide', 'motion.snap',
      'motion.drift', 'motion.drop', 'motion.zoom', 'motion.flip',
      'motion.blur', 'motion.blur.desc',
      'motion.close', 'motion.close.desc', 'motion.exit', 'motion.exit.desc',
      'motion.exit.fade', 'motion.exit.ghost', 'motion.exit.sink', 'motion.exit.shrink',
      'motion.toast', 'motion.toast.desc', 'motion.toastExit', 'motion.toastExit.desc',
    ]) {
      assert.ok(Object.hasOwn(catalogue[language], key), `${language} is missing ${key}`)
      assert.ok(catalogue[language][key].trim().length > 0, `${language}.${key} is empty`)
    }
    assert.doesNotMatch(catalogue[language]['motion.style.desc'], /\{\w+\}/u)
    const names = ['jelly', 'soft', 'slide', 'snap', 'drift', 'drop', 'zoom', 'flip']
      .map(id => catalogue[language][`motion.${id}`])
    assert.equal(new Set(names).size, names.length, `${language} style names are not distinct`)
    const exits = ['fade', 'ghost', 'sink', 'shrink'].map(id => catalogue[language][`motion.exit.${id}`])
    assert.equal(new Set(exits).size, exits.length, `${language} exit names are not distinct`)
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
