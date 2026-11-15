// Round-9 audit-fix tests (v1.37.24).
//
// Every case here maps to one entry of 增强插件-bug报告-v1.37.23.md whose fix is a
// pure function inside client.js's module closure. The shipped source text is
// sliced and evaluated, so these assert the code in the repository rather than a
// copy of it.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8')

/** Slice one region of client.js between two anchors. */
const slice = (startAnchor, endAnchor) => {
  const start = clientSource.indexOf(startAnchor)
  const end = clientSource.indexOf(endAnchor)
  assert.ok(start >= 0 && end > start, `missing anchors: ${startAnchor} / ${endAnchor}`)
  return clientSource.slice(start, end)
}

const editor = new Function(`${slice('    const ruleStartOf = ', '    const draftOf = ')}
return { ruleStartOf }`)()

const archive = new Function(`${slice('    const archiveCalendarOf = ', '    const sessionTitleLine = ')}
return { buildArchiveGroups }`)()

const tr = (key) => key
const ruleOf = (body, start) => `DTSTART;TZID=Asia/Shanghai:${start}\nRRULE:${body}`

// ---------------------------------------------------------------------------
// L1: a four-digit clock used to produce "09:00:" because `??` kept the empty
// slice; the seconds fallback has to treat "" as missing.
// ---------------------------------------------------------------------------
test('L1 a four-digit DTSTART clock falls back to :00 seconds', () => {
  const start = editor.ruleStartOf(ruleOf('FREQ=DAILY', '20260115T0930'))
  assert.deepEqual(start, { date: '2026-01-15', time: '09:30:00' })
})

test('L1 a six-digit DTSTART clock keeps its seconds', () => {
  const start = editor.ruleStartOf(ruleOf('FREQ=DAILY', '20260115T093045'))
  assert.deepEqual(start, { date: '2026-01-15', time: '09:30:45' })
})

// ---------------------------------------------------------------------------
// M5: the time grouping used to keep the incoming order, so switching the sort
// in the confirmation list only regrouped. Months, days and the rows inside a
// day are all newest-first now, with the undated bucket last.
// ---------------------------------------------------------------------------
const at = (year, month, day) => Date.UTC(year, month - 1, day, 12, 0, 0)

test('M5 time grouping sorts months, days and rows newest first', () => {
  const rows = [
    { id: 'a', workspace: 'w', stamp: at(2026, 1, 10) },
    { id: 'b', workspace: 'w', stamp: at(2026, 2, 3) },
    { id: 'c', workspace: 'w', stamp: at(2026, 1, 20) },
    { id: 'd', workspace: 'w', stamp: at(2026, 2, 9) },
  ]
  const months = archive.buildArchiveGroups(rows, 'time', tr)
  assert.deepEqual(months.map((month) => month.key), ['m:2026-02', 'm:2026-01'])
  assert.deepEqual(months[0].days.map((day) => day.key), ['d:2026-02-09', 'd:2026-02-03'])
  assert.deepEqual(months[0].days[0].rows.map((row) => row.id), ['d'])
  assert.deepEqual(months[1].days.map((day) => day.key), ['d:2026-01-20', 'd:2026-01-10'])
})

test('M5 a row without a date stays last', () => {
  const rows = [
    { id: 'undated', workspace: 'w', stamp: 0 },
    { id: 'dated', workspace: 'w', stamp: at(2026, 3, 1) },
  ]
  const months = archive.buildArchiveGroups(rows, 'time', tr)
  assert.equal(months[months.length - 1].key, 'm:unknown')
})

test('M5 workspace order is still name-sorted, rows untouched', () => {
  const rows = [
    { id: 'a', workspace: 'beta', stamp: 1 },
    { id: 'b', workspace: 'alpha', stamp: 2 },
  ]
  const groups = archive.buildArchiveGroups(rows, 'workspace', tr)
  assert.deepEqual(groups.map((group) => group.label), ['alpha', 'beta'])
  assert.deepEqual(groups[1].rows.map((row) => row.id), ['a'])
})
