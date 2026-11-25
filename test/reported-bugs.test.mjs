// Regression tests for the defects listed in the v1.37.58 audit
// (修复后 v1.37.60):
//   H1 - a Tab press inside a dialog opened from the settings sheet used to
//        land on the sheet behind it; the trap now takes every press and a
//        focusin guard pulls stray focus back.
//   H2 - clearing hidden conversations ran immediately; it now confirms first
//        and lists the rows that will be removed.
//   L1 - the injected subagent arrow did not cancel the fold queued by a row
//        click, so the fold fired afterwards and flipped the tree back.
//   L2 - closing a dialog left focus wherever it was; it is returned to the
//        opener.
//   M1 - the Window host reported any "WebView2" message as a missing runtime,
//        wrote no log, and left a failed window open forever.
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('../', import.meta.url)
const client = await readFile(new URL('client.js', root), 'utf8')
const native = await readFile(new URL('native/OveWindow.cs', root), 'utf8')
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

test('H1: the modal trap takes every Tab instead of only the wrap at the ends', () => {
  const handler = between(client, "if (event.key !== 'Tab') return;", 'window.addEventListener')
  assert.match(handler, /event\.preventDefault\(\);/u)
  assert.match(handler, /event\.stopPropagation\(\);/u)
  // Moving focus itself, not falling through to the browser default.
  const preventAt = handler.indexOf('event.preventDefault()')
  const nodesAt = handler.indexOf('const nodes =')
  assert.ok(preventAt !== -1 && nodesAt !== -1 && preventAt < nodesAt,
    'Tab must be consumed before the focus list is built')
  assert.match(handler, /index === -1 \|\| index === nodes.length - 1/u)
  // The old early return let the press reach the settings sheet behind.
  assert.doesNotMatch(handler, /if \(nodes.length === 0\) return;/u)
})

test('H1/L2: focus that escapes the dialog is pulled back and returned on close', () => {
  const effect = between(client, "document.addEventListener('focusin', onFocusIn, true)", '}, [open, panelRef, token]);')
  assert.match(effect, /previous\.isConnected/u)
  assert.match(effect, /previous\.focus\(\)/u)
  const trap = between(client, 'const onFocusIn = (event) => {', 'document.addEventListener')
  assert.match(trap, /panel\.contains\(target\)/u)
  assert.match(trap, /focusFirst\(\)/u)
})

test('H2: clearing hidden conversations opens a confirmation that lists the rows', () => {
  // The toolbar button opens the confirmation instead of deleting.
  const button = between(client, "className: 'ove-btn ove-btn-danger',", "hiddenBusy ? tr('hiddenManageClearing')")
  assert.match(button, /onClick: \(\) => setHiddenConfirm\(true\)/u)
  const confirm = between(client, 'hiddenOpen && hiddenConfirm && overlayPortal', 'h(ArchivePicker, {')
  assert.match(confirm, /hiddenManageConfirmTitle/u)
  assert.match(confirm, /\.replace\('\{n\}', String\(hiddenSelectedRows\.length\)\)/u)
  // Confirmed removal closes the confirmation together with the manager.
  const clear = between(client, 'const clearHidden = async () => {', 'const groupHead =')
  assert.match(clear, /setHiddenConfirm\(false\);/u)
})

test('H2: the confirmation is a real modal with its own focus trap and state', () => {
  assert.match(client, /const hiddenConfirmRef = React\.useRef\(null\);/u)
  assert.match(client, /useModalKeyboard\(hiddenConfirmRef, \(\) => setHiddenConfirm\(false\), hiddenBusy, hiddenOpen && hiddenConfirm\);/u)
  assert.match(client, /const \[hiddenConfirm, setHiddenConfirm\] = React\.useState\(false\);/u)
  // A read-only list: no selection props, so the tree stays a receipt.
  const picker = between(client, 'h(ArchivePicker, {', 'h(\'div\', { className: \'ove-dialog-actions\' }')
  assert.doesNotMatch(picker, /onToggle/u)
})

test('H2: the confirmation keys exist in both languages', () => {
  for (const language of ['zh', 'en']) {
    for (const key of ['hiddenManageConfirmTitle', 'hiddenManageConfirmDesc', 'hiddenManageConfirm']) {
      assert.ok(Object.hasOwn(catalogue[language], key), language + ' is missing ' + key)
      assert.ok(catalogue[language][key].trim().length > 0, language + '.' + key + ' is empty')
    }
  }
  assert.deepEqual(Object.keys(catalogue.zh).sort(), Object.keys(catalogue.en).sort())
})

test('L1: the subagent arrow cancels the fold queued by a row press', () => {
  const arrow = between(client, "button.className = 'ove-sub-toggle';", 'button.dataset.signature')
  assert.match(arrow, /cancelParentToggle\(\);\s+toggle\(parentId\);/u)
})

test('M1: a startup failure is logged, real detection, and never released to hang', () => {
  assert.match(native, /private static bool MissingWebView2Runtime\(\)/u)
  assert.match(native, /GetAvailableBrowserVersionString\(\)/u)
  assert.match(native, /startup-error\.log/u)
  assert.match(native, /File\.AppendAllText\(path/u)
  // The failure path must not release the startup watchdog (the success path
  // still does, right after the navigation starts).
  const load = between(native, 'protected override async void OnLoad', 'private void StartStartupWatchdog()')
  const catchAt = load.indexOf('catch (Exception error)')
  assert.notEqual(catchAt, -1, 'missing OnLoad catch block')
  const closeAt = load.indexOf('\n            }\n', catchAt)
  assert.notEqual(closeAt, -1, 'missing end of the OnLoad catch block')
  const failure = load.slice(catchAt, closeAt)
  assert.doesNotMatch(failure, /startupDone\.Set\(\);/u)
  assert.match(failure, /ShowStartupError\(error\);/u)
  // And the old string-match / modal-report path is gone.
  const reporter = between(native, 'private void ShowStartupError(Exception error)', 'private static bool MissingWebView2Runtime')
  assert.doesNotMatch(reporter, /MessageBox\.Show/u)
  assert.match(reporter, /MissingWebView2Runtime\(\)/u)
  assert.match(reporter, /WriteStartupLog\(error\)/u)
})

test('the release metadata matches the fix', () => {
  assert.equal(manifest.version, '1.37.74')
  assert.match(readme, /## 更新记录（v1\.37\.74）/u)
})
