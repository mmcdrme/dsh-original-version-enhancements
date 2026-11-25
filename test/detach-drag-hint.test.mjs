// Regression tests for detaching a conversation by dragging it out (v1.37.62).
//
// Two user-visible defects are locked here:
//   - the shipped sidebar reorders with the same drag and commits the last
//     hovered row on dragend, so dragging out used to reorder the list while a
//     window opened. Dropping the conversation onto its own row first makes
//     that commit a no-op.
//   - the drag image stayed a copy of the row, which reads as "reorder"; once
//     the pointer leaves the window it becomes a black pill that says releasing
//     opens a window.
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('../', import.meta.url)
const client = await readFile(new URL('client.js', root), 'utf8')
const css = await readFile(new URL('css/style.css', root), 'utf8')
const catalogue = JSON.parse(await readFile(new URL('locale/lang.json', root), 'utf8'))
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
const readme = await readFile(new URL('README.md', root), 'utf8')

const between = (text, start, end) => {
  const from = text.indexOf(start)
  assert.notEqual(from, -1, 'missing anchor: ' + start)
  const to = text.indexOf(end, from + start.length)
  assert.notEqual(to, -1, 'missing end anchor: ' + end)
  return text.slice(from, to)
}

test('detaching cancels the sidebar reorder by dropping onto the dragged row', () => {
  const end = between(client, 'const onDragEnd = (event) => {', '}, [ctx, tr, windowAppearance.mode, windowAppearance.split]);')
  assert.match(end, /row\.dispatchEvent\(new DragEvent\('drop', \{/u)
  assert.match(end, /clientX: rect\.left \+ 4/u)
  assert.match(end, /dataTransfer: event\.dataTransfer/u)
  // The self-drop must happen before the window is requested.
  const dropAt = end.indexOf("new DragEvent('drop'")
  const detachAt = end.indexOf('scheduleDetach(state.id')
  assert.ok(dropAt !== -1 && detachAt !== -1 && dropAt < detachAt, 'cancel the reorder first, then open')
})

test('sorting is only allowed inside the workspace; releasing elsewhere opens a window', () => {
  const over = between(client, 'const onDragOver = (event) => {', 'const notePosition = (state, event, point) => {')
  assert.match(over, /const zone = zoneOf\(point\)/u)
  assert.match(over, /zone === 'outside'/u)
  assert.match(over, /showOverlay\(\)/u)
  assert.match(over, /zone === 'window'/u)
  assert.match(over, /hintPreview\(dragging, labelFor\('detachDragHint', 'outside'\)/u)
  assert.match(over, /hintPreview\(dragging, labelFor\('detachDragHint', 'window'\)/u)
  // Back in the workspace the reorder preview is handed back at the row under
  // the pointer (resolved by point too, because the preview rides the cursor).
  assert.match(over, /if \(dragging\.hinted !== false\)/u)
  assert.match(over, /const row = rowUnder\(event, point\);/u)
  assert.match(over, /restoreOverRow\(dragging, event, row\)/u)
  // The workspace is the block the session rows live in.
  const workspace = between(client, 'const workspaceOf = () => {', 'const insideWorkspace')
  assert.match(workspace, /data-row-key\^="session:"/u)
  assert.match(workspace, /Math\.min\(\.\.\.boxes\.map/u)
  const zones = between(client, 'const insideWorkspace = (point) =>', 'const overlayNode')
  assert.match(zones, /workspaceRect\.left/u)
  assert.match(zones, /if \(insideWorkspace\(point\)\) return 'workspace';/u)
  assert.match(zones, /if \(atOutside\(point\) \|\| nearFrame\(point\)\) return 'outside';/u)
  assert.match(client, /const FRAME_BAND_PX = 56;/u)
  // A release outside the workspace detaches; one inside it commits the reorder.
  const end = between(client, 'const onDragEnd = (event) => {', 'const clearStalePill')
  assert.match(end, /if \(state\.zone === 'workspace' && !rawOutside\) return;/u)
  assert.match(end, /dispatchEvent\(new DragEvent\('drop'/u)
  const resolver = between(client, 'const rowUnder = (event, point) => {', 'const onDragOver = (event) => {')
  assert.match(resolver, /document\.elementFromPoint\(point\.x, point\.y\)/u)
  assert.match(resolver, /rowOf\(event\.target\)/u)
  assert.match(resolver, /rowOf\(under\)/u)
  // `dragover` is throttled, so the way back from the edge may only arrive as
  // a `dragenter`; that handler must keep the intent honest too.
  assert.match(client, /const onDragEnter = \(event\) => \{/u)
  assert.match(client, /addEventListener\('dragenter', onDragEnter, true\)/u)
  const restore = between(client, 'const restoreOverRow = (state, event, row) => {', 'const onDragEnter = (event) => {')
  assert.match(restore, /restorePreview\(state\)/u)
  assert.match(restore, /new DragEvent\('dragover', \{/u)
  const hint = between(client, 'const hintPreview = (state, text) => {', 'const onDragStart = (event) => {')
  assert.match(hint, /state\.previewHtml = preview\.innerHTML/u)
  assert.match(hint, /preview\.replaceChildren\(\)/u)
  assert.match(hint, /classList\.add\('ove-detach-drag-preview'\)/u)
  // Leaving the window also hides the sidebar's reorder insertion line.
  assert.match(hint, /intentMark\(true\)/u)
  // The pill is positioned from the last *valid* pointer sample, because the
  // dragleave that reports the exit often carries (0, 0).
  assert.match(hint, /showPill\(text, state\.lastX, state\.lastY\)/u)
  // The pill is its own fixed element: the desktop client's WebView does not
  // lay out the sidebar's preview clone inside the page, so a pill nested in it
  // was invisible there. It carries the menu glyph and the localized sentence.
  const pill = between(client, 'const pillNode = () => {', 'const placePill = (node, x, y) => {')
  assert.match(pill, /className = 'ove-detach-drag-hint ove-detach-drag-floater'/u)
  assert.match(pill, /document\.body\.appendChild\(node\)/u)
  const icon = between(client, 'const iconSvg = () => {', 'let pill = null;')
  assert.match(icon, /createElementNS\('http:\/\/www\.w3\.org\/2000\/svg', 'svg'\)/u)
  assert.match(icon, /for \(const d of DETACH_ICON_PATHS\)/u)
  const floater = between(client, 'const placePill = (node, x, y) => {', 'const hidePill = () => {')
  assert.match(floater, /node\.offsetWidth/u)
  assert.match(floater, /node\.style\.left/u)
  // Next to the pointer, sliding only as far as needed to stay on screen.
  assert.match(floater, /Math\.max\(x \+ 12, 6\)/u)
  assert.match(floater, /Math\.max\(y \+ 14, 6\)/u)
  assert.doesNotMatch(floater, /x - width - 18/u)
  const menuIcon = between(client, 'function DetachIcon() {', 'One session-menu row')
  assert.match(menuIcon, /DETACH_ICON_PATHS\.map/u)
  const glyph = between(client, 'const DETACH_ICON_PATHS = [', 'function DetachIcon() {')
  assert.match(glyph, /M6\.5 3\.2H3\.6/u)
  assert.match(glyph, /M13\.4 2\.6 7\.6 8\.4/u)
  // One definition, used by both places.
  assert.equal(client.split('const DETACH_ICON_PATHS = [').length - 1, 1)
})

test('a fast exit is caught by the edge-idle watchdog and dragenter re-lines the row', () => {
  // A pointer that leaves quickly can stop delivering drag events before any
  // one of them says "outside"; the line would then freeze on the last row.
  const idle = between(client, 'state.timer = globalThis.setInterval', '};')
  assert.match(idle, /Date\.now\(\) - live\.lastEvent < 220/u)
  assert.match(idle, /window\.innerWidth - 64/u)
  assert.match(idle, /const atFrame = live\.lastX <= 64/u)
  assert.match(idle, /live\.moved !== true/u)
  assert.match(idle, /hintPreview\(live, labelFor\('detachDragHint', 'outside'\)/u)
  // Entering a row also asks the shipped row for a fresh insertion line, so a
  // fast sweep does not leave the line behind.
  // An exit may report (0, 0); then the screen coordinates are used instead so
  // the pill stays at the real pointer rather than in the top-left corner.
  assert.match(client, /const pointerOf = \(event\) => \{/u)
  assert.match(client, /event\.clientX === 0 && event\.clientY === 0/u)
  assert.match(client, /screenX - originX - borderX/u)
  const enter = between(client, 'const onDragEnter = (event) => {', 'const onDragLeave = (event) => {')
  assert.match(enter, /nudgeRow\(dragging, event, row\)/u)
  assert.match(enter, /restoreOverRow\(dragging, event, row\)/u)
  const nudge = between(client, 'const nudgeRow = (state, event, row) => {', 'const restoreOverRow = (state, event, row) => {')
  assert.match(nudge, /new DragEvent\('dragover', \{/u)
  assert.match(nudge, /if \(state\.lastRow === row\) return;/u)
})

test('a drag past the window edge shows the large blurred drop card', () => {
  const overlay = between(client, 'const overlayNode = () => {', 'const onDragStart = (event) => {')
  assert.match(overlay, /className = 'ove-detach-drop-overlay'/u)
  assert.match(overlay, /className = 'ove-detach-drop-card'/u)
  assert.match(overlay, /labelFor\('detachDropLabel', 'outside'\)/u)
  assert.match(overlay, /document\.body\.appendChild\(node\)/u)
  assert.match(overlay, /classList\.add\('is-visible'\)/u)
  assert.ok(css.includes('.ove-detach-drop-overlay'), 'missing the drop overlay style')
  assert.ok(css.includes('backdrop-filter: blur(7px)'), 'the overlay must blur the window')
  assert.ok(css.includes('-webkit-backdrop-filter'), 'Safari/WebView needs the prefixed blur too')
  assert.ok(css.includes('.ove-detach-drop-card'), 'missing the drop card style')
  for (const language of ['zh', 'en']) {
    assert.ok(Object.hasOwn(catalogue[language], 'detachDropLabel'), language + ' is missing detachDropLabel')
    assert.ok(catalogue[language].detachDropLabel.trim().length > 0)
  }
  // A desktop drag released over another app may never fire dragend; any later
  // pointer/key activity and a 12 s ceiling both clear the leftover hint/card.
  assert.match(client, /const clearStalePill = \(\) => \{/u)
  assert.match(client, /Date\.now\(\) - dragging\.lastEvent < 200/u)
  assert.match(client, /hideOverlay\(\)/u)
  assert.match(client, /addEventListener\('mouseup', clearStalePill, true\)/u)
  assert.match(client, /addEventListener\('pointerup', clearStalePill, true\)/u)
  assert.match(client, /addEventListener\('blur', clearStalePill\)/u)
  assert.match(client, /pillTimer = globalThis\.setTimeout\(/u)
})

test('the hint names the configured window shape, and detach waits for a cancel', () => {
  assert.match(client, /const windowAppearance = useWindow\(\);/u)
  assert.match(client, /const labelFor = \(base, zone\) => \{/u)
  for (const language of ['zh', 'en']) {
    for (const key of ['detachDragHintPanel', 'detachDropLabelPanel']) {
      assert.ok(Object.hasOwn(catalogue[language], key), language + ' is missing ' + key)
      assert.ok(catalogue[language][key].includes('页内') || catalogue[language][key].includes('in-page'), key + ' must name the in-page window')
    }
  }
  // Opening waits a moment so a right-click arriving right after dragend can
  // still cancel it (Windows sometimes reports the cancel only then).
  assert.match(client, /let pendingDetach = null;/u)
  assert.match(client, /const cancelPendingDetach = \(\) => \{/u)
  assert.match(client, /const scheduleDetach = \(id, mode\) => \{/u)
  assert.match(client, /scheduleDetach\(state\.id, modeForZone\(state\.zone\)\);/u)
  assert.match(client, /if \(\(event\.buttons & 2\) !== 0\) return;/u)
  assert.match(client, /addEventListener\('auxclick', cancelDetach, true\)/u)
  // And the card must sit above the app's own layers.
  assert.ok(css.includes('z-index: 2147483646'), 'the drop overlay must be on top')
})

test('the split option picks the window kind from the drop position', () => {
  // Stored next to the other window settings, default off.
  assert.match(client, /mode: 'native', split: false/u)
  assert.match(client, /split: saved\.split === true/u)
  assert.match(client, /split: next\.split === true/u)
  // A switch in the window section.
  assert.match(client, /switchRow\('window\.split', appearance\.split === true/u)
  // Past the edge is the desktop window, inside the page is the in-page one.
  assert.match(client, /const splitWindows = windowAppearance\.split === true;/u)
  assert.match(client, /const modeForZone = \(zone\) => \(splitWindows/u)
  assert.match(client, /\? \(zone === 'outside' \? 'native' : 'panel'\)/u)
  assert.match(client, /scheduleDetach\(state\.id, modeForZone\(state\.zone\)\)/u)
  // detachSession honours the per-action mode.
  assert.match(client, /const wantedMode = WINDOW_MODES\.includes\(labels\?\.mode\)/u)
  assert.match(client, /const appearance = \{ \.\.\.baseAppearance, mode: wantedMode \};/u)
  for (const language of ['zh', 'en']) {
    for (const key of ['window.split', 'window.split.desc']) {
      assert.ok(Object.hasOwn(catalogue[language], key), language + ' is missing ' + key)
    }
  }
})

test('a right-click during the drag cancels the detach effect', () => {
  assert.match(client, /cancelled: false/u)
  const cancel = between(client, 'const cancelDetach = (event) => {', "window.addEventListener('mousedown', cancelDetach, true)")
  assert.match(cancel, /const rightButton = event\.button === 2 \|\| event\.type === 'contextmenu';/u)
  assert.match(cancel, /if \(rightButton && cancelPendingDetach\(\)\) return;/u)
  assert.match(cancel, /dragging\.cancelled = true/u)
  assert.match(cancel, /hideOverlay\(\)/u)
  assert.match(cancel, /hidePill\(\)/u)
  assert.match(cancel, /intentMark\(false\)/u)
  assert.match(cancel, /restorePreview\(dragging\)/u)
  assert.match(client, /addEventListener\('mousedown', cancelDetach, true\)/u)
  assert.match(client, /addEventListener\('contextmenu', cancelDetach, true\)/u)
  // A cancelled gesture must not open a window, and no later drag event may
  // paint the hint again.
  assert.match(client, /if \(state\.cancelled === true \|\| Date\.now\(\) - lastRightDown < 600\) return;/u)
  assert.match(client, /let lastRightDown = 0;/u)
  assert.match(client, /addEventListener\('pointerdown', noteRightDown, true\)/u)
  const over = between(client, 'const onDragOver = (event) => {', 'const notePosition')
  assert.match(over, /if \(dragging\.cancelled === true\) return;/u)
})

test('the hint and its preview styling exist in both places', () => {
  for (const language of ['zh', 'en']) {
    assert.ok(Object.hasOwn(catalogue[language], 'detachDragHint'), language + ' is missing detachDragHint')
    assert.ok(catalogue[language].detachDragHint.trim().length > 0)
  }
  assert.ok(css.includes('.ove-detach-drag-hint {'), 'missing the drag hint style')
  assert.ok(css.includes('background: rgba(17, 24, 39, .94)'), 'missing the drag hint background')
  assert.ok(css.includes('.ove-detach-drag-floater'), 'the hint must be its own fixed element')
  assert.ok(css.includes('.ove-detach-drag-preview {'), 'missing the preview reset style')
  assert.ok(css.includes('background: transparent !important'), 'the preview must drop its row background')
})

test('the release metadata matches the fix', () => {
  assert.equal(manifest.version, '1.37.73')
  assert.match(readme, /## 更新记录（v1\.37\.73）/u)
})
