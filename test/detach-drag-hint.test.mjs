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
  const end = between(client, 'const onDragEnd = (event) => {', '}, [ctx, tr]);')
  assert.match(end, /row\.dispatchEvent\(new DragEvent\('drop', \{/u)
  assert.match(end, /clientX: rect\.left \+ 4/u)
  assert.match(end, /dataTransfer: event\.dataTransfer/u)
  // The self-drop must happen before the window is requested.
  const dropAt = end.indexOf("new DragEvent('drop'")
  const detachAt = end.indexOf('detachSession(ctx, state.id')
  assert.ok(dropAt !== -1 && detachAt !== -1 && dropAt < detachAt, 'cancel the reorder first, then open')
})

test('the drag image becomes the release hint only while the pointer is outside', () => {
  const over = between(client, 'const onDragOver = (event) => {', 'const onDrop = () => {')
  assert.match(over, /if \(outside && dragging\.outside !== true\)/u)
  assert.match(over, /hintPreview\(dragging\)/u)
  assert.match(over, /else if \(!outside && dragging\.outside === true\)/u)
  assert.match(over, /restorePreview\(dragging\)/u)
  const hint = between(client, 'const hintPreview = (state) => {', 'const onDragStart = (event) => {')
  assert.match(hint, /state\.previewHtml = preview\.innerHTML/u)
  assert.match(hint, /replaceChildren\(hintOf/u)
  assert.match(hint, /classList\.add\('ove-detach-drag-preview'\)/u)
  // The pill carries a window glyph and the localized sentence.
  const pill = between(client, 'const hintOf = (text) => {', 'const hintPreview = (state) => {')
  assert.match(pill, /createElementNS\('http:\/\/www\.w3\.org\/2000\/svg', 'svg'\)/u)
  assert.match(pill, /className = 'ove-detach-drag-hint'/u)
})

test('the hint and its preview styling exist in both places', () => {
  for (const language of ['zh', 'en']) {
    assert.ok(Object.hasOwn(catalogue[language], 'detachDragHint'), language + ' is missing detachDragHint')
    assert.ok(catalogue[language].detachDragHint.trim().length > 0)
  }
  assert.ok(css.includes('.ove-detach-drag-hint {'), 'missing the drag hint style')
  assert.ok(css.includes('background: rgba(17, 24, 39, .94)'), 'missing the drag hint background')
  assert.ok(css.includes('.ove-detach-drag-preview {'), 'missing the preview reset style')
  assert.ok(css.includes('background: transparent !important'), 'the preview must drop its row background')
})

test('the release metadata matches the fix', () => {
  assert.equal(manifest.version, '1.37.62')
  assert.match(readme, /## 更新记录（v1\.37\.62）/u)
})
