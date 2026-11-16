// Tests for the subagent sidebar gestures added after the first release:
//
//   - clicking the already-open conversation row folds/unfolds its subagent
//     children, while the stock double-click still opens the rename dialog;
//   - the injected rows cannot start a text selection;
//   - the subagent context menu copies the conversation name between the id
//     and the transfer action.
//
// The click classifier is shipped as a pure function, so the cases evaluate the
// real source text instead of re-implementing the rules here.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const clientSource = await readFile(new URL('client.js', root), 'utf8')
const catalogue = JSON.parse(await readFile(new URL('locale/lang.json', root), 'utf8'))

const gestureWith = () => {
  const start = clientSource.indexOf('    const PARENT_ROW_TOGGLE_DELAY_MS = ')
  const end = clientSource.indexOf('    const installSubagentTree = ')
  assert.ok(start >= 0 && end > start, 'missing subagent gesture anchors')
  const factory = new Function(`${clientSource.slice(start, end)}
return { PARENT_ROW_TOGGLE_DELAY_MS, parentRowGesture }`)
  return factory()
}

const click = (overrides = {}) => ({ button: 0, detail: 1, ...overrides })

test('the open conversation row folds on a plain click', () => {
  const { parentRowGesture, PARENT_ROW_TOGGLE_DELAY_MS } = gestureWith()
  assert.equal(parentRowGesture(click(), true, true), 'toggle')
  // Long enough to see the second press of a double-click, short enough to
  // feel immediate when the click is really single.
  assert.ok(PARENT_ROW_TOGGLE_DELAY_MS >= 200 && PARENT_ROW_TOGGLE_DELAY_MS <= 400)
})

test('every other click stays with the shipped row', () => {
  const { parentRowGesture } = gestureWith()
  // A conversation that is not the open one still opens normally.
  assert.equal(parentRowGesture(click(), false, true), 'stock')
  // A conversation without subagents has nothing to fold.
  assert.equal(parentRowGesture(click(), true, false), 'stock')
  // Only the primary button folds.
  assert.equal(parentRowGesture(click({ button: 1 }), true, true), 'stock')
  assert.equal(parentRowGesture(click({ button: 2 }), true, true), 'stock')
})

test('the second press of a double-click cancels the fold', () => {
  const { parentRowGesture } = gestureWith()
  assert.equal(parentRowGesture(click({ detail: 2 }), true, true), 'double')
  assert.equal(parentRowGesture(click({ detail: 3 }), true, true), 'double')
})

test('the stock row is wired for both the fold and the rename gesture', () => {
  // The row belongs to the shipped browser: the fold takes the click, the
  // capture-phase dblclick only cancels it and then lets the rename through.
  assert.match(clientSource, /const wireParentRow = \(row\) => \{/u)
  assert.match(clientSource, /row\.addEventListener\('dblclick', cancelParentToggle, true\)/u)
  assert.match(clientSource, /const gesture = parentRowGesture\(event, selected, true\)/u)
  assert.match(clientSource, /event\.preventDefault\(\);\n\s+event\.stopPropagation\(\);\n\s+cancelParentToggle\(\);/u)
  assert.match(clientSource, /if \(gesture === 'double'\) return;/u)
  // Wired by the same paint that draws the expander, and cleaned up with it.
  assert.match(clientSource, /const paintToggle = \(row, parentId\) => \{[\s\S]*?wireParentRow\(row\);/u)
  assert.match(clientSource, /const cancelParentToggle = \(\) => \{/u)
  assert.match(clientSource, /stopped = true;\n\s+cancelParentToggle\(\);/u)
})

test('the injected subagent rows cannot start a text selection', () => {
  const start = clientSource.indexOf('const SUBAGENT_TREE_CSS = `')
  const css = clientSource.slice(start, clientSource.indexOf('`;', start + 100))
  assert.ok(start >= 0 && css.length > 1000, 'missing subagent stylesheet')
  assert.match(css, /\.ove-sub-host \{ display: block; user-select: none; -webkit-user-select: none; \}/u)
  assert.match(css, /\.ove-sub-row \{[\s\S]*?user-select: none; -webkit-user-select: none;/u)
})

test('the subagent menu copies the conversation name between the two actions', () => {
  for (const language of ['zh', 'en']) {
    for (const key of ['subagentMenu.copyName', 'subagentMenu.copyNameDone', 'subagentMenu.copyNameFailed']) {
      assert.ok(Object.hasOwn(catalogue[language], key), `${language} is missing ${key}`)
      assert.ok(catalogue[language][key].trim().length > 0, `${language}.${key} is empty`)
    }
  }
  assert.equal(catalogue.zh['subagentMenu.copyName'], '复制会话名')
  const rows = clientSource.slice(
    clientSource.indexOf('function SubagentMenuRows('),
    clientSource.indexOf('function SubagentMenuContent('),
  )
  assert.ok(rows.length > 200, 'missing subagent menu rows')
  const copyId = rows.indexOf("labelKey: 'subagentMenu.copyId'")
  const copyName = rows.indexOf("labelKey: 'subagentMenu.copyName'")
  const transfer = rows.indexOf('h(SessionTransferMenuItem, {')
  assert.ok(copyId >= 0 && copyName > copyId && transfer > copyName, 'copy-name row is not between the two actions')
  // It copies the menu target's displayed name, not its id.
  assert.match(clientSource, /copySubagentName = \(ctx, name, tr\) => copySubagentText\(/u)
  assert.match(rows, /void copySubagentName\(ctx, displayTitle, tr\)/u)
})
