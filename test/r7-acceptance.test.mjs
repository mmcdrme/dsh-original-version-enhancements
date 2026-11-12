// Round-7 acceptance tests for 1f9abc2 (v1.14.2).
//
// The schedule editor's pure helpers live inside client.js's module closure, so
// they cannot be imported. These cases slice the exact shipped source text and
// evaluate it in an isolated function: the behaviour under test is the code in
// the repository, not a copy of it.

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8')

/** Slice one region of client.js between two anchors. */
const slice = (startAnchor, endAnchor) => {
  const start = clientSource.indexOf(startAnchor)
  const end = clientSource.indexOf(endAnchor)
  assert.ok(start >= 0 && end > start, `missing anchors: ${startAnchor} / ${endAnchor}`)
  return clientSource.slice(start, end)
}

/** Editor classifiers as shipped in v1.14.2. */
const editor = new Function(`${slice('    const WORKDAYS = ', '    const draftOf = ')}
return { repeatKindOf, isWorkdayRule, ruleStartOf }`)()

/** Timing builder as shipped in v1.14.2, with its three host-facing helpers. */
const timingOfDraft = new Function('timeZone', 'withSeconds', 'rruleClock', `${slice('    const timingOfDraft = ', '    const targetOfDraft = ')}
return timingOfDraft`)(() => 'Asia/Shanghai', value => value, value => String(value).replace(/:/g, ''))

const ruleOf = (body, start = '20260105T090000') => `DTSTART;TZID=Asia/Shanghai:${start}\nRRULE:${body}`

// ---------------------------------------------------------------------------
// GREEN: the two fixed classifier branches (2-4 and part of 2-1).
// ---------------------------------------------------------------------------
test('A1 the five-weekday rule is the guided workday kind', () => {
  assert.equal(editor.repeatKindOf({ kind: 'rrule', rrule: ruleOf('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR') }), 'weekdays')
})

test('A2 a six-day rule is not the workday kind', () => {
  assert.notEqual(editor.repeatKindOf({ kind: 'rrule', rrule: ruleOf('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA') }), 'weekdays')
})

test('A3 the stored DTSTART is what the editor shows', () => {
  const start = editor.ruleStartOf(ruleOf('FREQ=MONTHLY;BYMONTHDAY=15', '20260115T093000'))
  assert.deepEqual(start, { date: '2026-01-15', time: '09:30:00' })
})

// ---------------------------------------------------------------------------
// RED (new): the workday classifier only looks at FREQ + BYDAY. A biweekly
// workday rule is therefore presented as the guided "workdays" form, and that
// form rewrites the rule without INTERVAL/UNTIL/COUNT: saving the title turns
// "every other week" into "every week" or drops an end date.
// ---------------------------------------------------------------------------
test('A4 a biweekly workday rule is not rewritten by the guided form', () => {
  const kind = editor.repeatKindOf({ kind: 'rrule', rrule: ruleOf('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TU,WE,TH,FR') })
  assert.notEqual(kind, 'weekdays', 'a rule carrying INTERVAL would lose it on save')
})

test('A5 a workday rule with UNTIL is not rewritten by the guided form', () => {
  const kind = editor.repeatKindOf({ kind: 'rrule', rrule: ruleOf('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;UNTIL=20261231T000000Z') })
  assert.notEqual(kind, 'weekdays', 'a rule carrying UNTIL would lose it on save')
})

// ---------------------------------------------------------------------------
// RED (new): deselecting every weekday falls back to `draft.weekday`, which is
// the first day the drawer opened with — not Monday as the comment promises.
// The saved rule can therefore repeat on the one day the human just removed.
// ---------------------------------------------------------------------------
test('A6 an empty weekday picker does not resurrect the removed day', () => {
  const timing = timingOfDraft({
    kind: 'weekly',
    weekdays: [],       // human turned every day off
    weekday: 3,         // Wednesday: the day the drawer opened on
    time: '09:00',
    interval: '1',
    delayUnit: 'min',
    date: '2026-01-01',
    monthDay: '1',
    rrule: '',
    cron: '0 9 * * *',
  })
  assert.deepEqual(timing.weekly.weekdays, [1], 'the documented fallback is Monday, never the removed day')
})

// ---------------------------------------------------------------------------
// GREEN: the copy index is dropped with its source task (2-9).
// ---------------------------------------------------------------------------
test('A7 the copy index of a removed source task is dropped', async () => {
  const { createAutomationSurface } = await import(new URL('../host/automation.mjs', import.meta.url))
  const state = { version: 2, autoClean: {}, ephemeral: {}, copies: { 'task-gone': ['copy-1'] } }
  const service = { catalog: async () => [{ id: 'copy-1', title: 'c', prompt: 'p', kind: 'every', status: 'active', everySeconds: 60, target: { kind: 'new' } }] }
  const surface = createAutomationSurface({ service, state, save: () => {}, warn: () => {} })
  await surface.reconcile()
  assert.deepEqual(state.copies, {})
})

// ---------------------------------------------------------------------------
// RED (new): revision adoption compares the editable content but not the task's
// run state. Another window pausing (or resuming) the task bumps the revision;
// the drawer adopts it while keeping its stale `active`, and the next save sends
// the opposite of what that window chose.
// ---------------------------------------------------------------------------
test('A8 a status change elsewhere blocks revision adoption', () => {
  const fields = slice('    const DRAFT_IDENTITY_FIELDS = ', '    const timingOfDraft = ')
  const sameDraftContent = new Function(`${fields}
return sameDraftContent`)()
  const left = {
    kind: 'daily', title: 't', prompt: 'p', targetKind: 'new', sessionId: '', cwd: '', agentPreset: '',
    time: '09:00', active: true,
  }
  const right = { ...left, active: false }
  assert.equal(sameDraftContent(left, right), false, 'a pause made in another window must surface as a conflict')
})
