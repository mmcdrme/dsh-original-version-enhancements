// Unit tests for the Workspace-binding highlight.
//
// `workspaceRowKeyFor` lives inside client.js's module closure, so the cases
// slice the shipped source text and evaluate it in an isolated function: the
// behaviour under test is the code in the repository, not a copy of it.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8')

const start = clientSource.indexOf('    const workspaceRowKeyFor = ')
const end = clientSource.indexOf('    /**\n     * The same pair as one plain string, for titles')
assert.ok(start >= 0 && end > start, 'missing workspaceRowKeyFor anchors')
const { workspaceRowKeyFor } = new Function(`${clientSource.slice(start, end)}
return { workspaceRowKeyFor }`)()

const items = [
  { id: 'ws-cli', title: 'CLI', path: 'C:\\repo\\CLI' },
  { id: 'ws-qq', title: 'dshqq_dfy', path: 'C:\\repo\\dshqq' },
  { id: 'ws-default', title: 'default-workspace', path: 'C:\\Users\\someone\\.dsh\\default-workspace' },
]

test('a bound workspace path selects its own row', () => {
  assert.equal(workspaceRowKeyFor('C:\\repo\\CLI', items), 'workspace:ws-cli')
  assert.equal(workspaceRowKeyFor('C:\\repo\\dshqq', items), 'workspace:ws-qq')
})

test('the path comparison ignores case and surrounding spaces', () => {
  assert.equal(workspaceRowKeyFor('  c:\\REPO\\cli ', items), 'workspace:ws-cli')
})

test('the default choice points at the automatic default Workspace', () => {
  assert.equal(workspaceRowKeyFor('', items), 'workspace:ws-default')
  // The same workspace recognised through its directory when the stored title
  // was renamed by hand.
  const renamed = [{ id: 'ws-x', title: '我的工作区', path: 'C:/x/default-workspace' }]
  assert.equal(workspaceRowKeyFor('', renamed), 'workspace:ws-x')
})

test('a workspace that no longer exists falls back to the ungrouped row', () => {
  assert.equal(workspaceRowKeyFor('C:\\gone\\away', items), 'workspace:')
  assert.equal(workspaceRowKeyFor('', []), 'workspace:')
})

test('the list may be absent while the projection loads', () => {
  assert.equal(workspaceRowKeyFor('', undefined), 'workspace:')
  assert.equal(workspaceRowKeyFor('C:\\repo\\CLI', null), 'workspace:')
})
