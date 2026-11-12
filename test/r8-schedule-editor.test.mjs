// Round-8 regression tests for the schedule editor's rule classifier.
//
// These slice the shipped client source the same way r7-acceptance.test.mjs
// does: the helpers live inside client.js's module closure, so the code under
// test is the repository text evaluated in an isolated function.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8')

const slice = (startAnchor, endAnchor) => {
  const start = clientSource.indexOf(startAnchor)
  const end = clientSource.indexOf(endAnchor)
  assert.ok(start >= 0 && end > start, `missing anchors: ${startAnchor} / ${endAnchor}`)
  return clientSource.slice(start, end)
}

const editor = new Function(`${slice('    const WORKDAYS = ', '    const draftOf = ')}
return { repeatKindOf, isWorkdayRule, isMonthlyRule }`)()

const timingOfDraft = new Function('timeZone', 'withSeconds', 'rruleClock', `${slice('    const timingOfDraft = ', '    const targetOfDraft = ')}
return timingOfDraft`)(() => 'Asia/Shanghai', value => value, value => String(value).replace(/:/g, ''))

const ruleOf = (bodyText, start = '20260105T090000') => `DTSTART;TZID=Asia/Shanghai:${start}\nRRULE:${bodyText}`

test('a plain workday rule still opens in the guided form', () => {
  assert.equal(editor.repeatKindOf({ kind: 'rrule', rrule: ruleOf('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR') }), 'weekdays')
  assert.equal(editor.repeatKindOf({ kind: 'rrule', rrule: ruleOf('FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR') }), 'weekdays')
})

test('a workday rule with clauses the guided form drops keeps the raw editor', () => {
  for (const bodyText of [
    'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TU,WE,TH,FR',
    'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;UNTIL=20261231T000000Z',
    'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;COUNT=10',
    'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;WKST=SU',
  ]) {
    assert.equal(editor.repeatKindOf({ kind: 'rrule', rrule: ruleOf(bodyText) }), 'rrule', bodyText)
  }
})

test('a monthly rule with extra clauses keeps the raw editor', () => {
  assert.equal(editor.repeatKindOf({ kind: 'rrule', rrule: ruleOf('FREQ=MONTHLY;BYMONTHDAY=5') }), 'monthly')
  assert.equal(editor.repeatKindOf({ kind: 'rrule', rrule: ruleOf('FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=5') }), 'rrule')
  assert.equal(editor.repeatKindOf({ kind: 'rrule', rrule: ruleOf('FREQ=MONTHLY;BYMONTHDAY=5;UNTIL=20261231T000000Z') }), 'rrule')
})

test('a rule with a second line the guided form cannot rebuild keeps the raw editor', () => {
  const withExdate = `${ruleOf('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR')}\nEXDATE;TZID=Asia/Shanghai:20260106T090000`
  assert.equal(editor.repeatKindOf({ kind: 'rrule', rrule: withExdate }), 'rrule')
  const doubled = `${ruleOf('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR')}\nRRULE:FREQ=WEEKLY;BYDAY=MO`
  assert.equal(editor.repeatKindOf({ kind: 'rrule', rrule: doubled }), 'rrule')
})

test('a rule without DTSTART keeps the raw editor', () => {
  // The guided form writes its own start; adopting a start-less rule would
  // invent one on the next save.
  assert.equal(editor.repeatKindOf({ kind: 'rrule', rrule: 'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' }), 'rrule')
  assert.equal(editor.repeatKindOf({ kind: 'rrule', rrule: 'RRULE:FREQ=MONTHLY;BYMONTHDAY=5' }), 'rrule')
})

test('the weekly form keeps every selected day', () => {
  const timing = timingOfDraft({
    kind: 'weekly', weekdays: [4, 1, 1, 2], weekday: 1, time: '09:00', interval: '1',
    delayUnit: 'min', date: '2026-01-01', monthDay: '1', rrule: '', cron: '0 9 * * *',
  })
  assert.deepEqual(timing.weekly.weekdays, [1, 2, 4])
})

test('an empty picker falls back to Monday, not the opening day', () => {
  for (const weekday of [0, 3, 6]) {
    const timing = timingOfDraft({
      kind: 'weekly', weekdays: [], weekday, time: '09:00', interval: '1',
      delayUnit: 'min', date: '2026-01-01', monthDay: '1', rrule: '', cron: '0 9 * * *',
    })
    assert.deepEqual(timing.weekly.weekdays, [1])
  }
})

const draftSource = slice('    const DRAFT_IDENTITY_FIELDS = ', '    const timingOfDraft = ')
const sameDraftContent = new Function(`${draftSource}
return sameDraftContent`)()

const baseDraft = {
  kind: 'daily', title: 't', prompt: 'p', targetKind: 'new', sessionId: '', cwd: '',
  agentPreset: '', time: '09:00', active: true,
}

test('a pause made elsewhere is a conflict, not an adoption', () => {
  assert.equal(sameDraftContent(baseDraft, { ...baseDraft, active: false }), false)
  assert.equal(sameDraftContent({ ...baseDraft, active: false }, baseDraft), false)
  assert.equal(sameDraftContent(baseDraft, { ...baseDraft }), true)
})

test('an ended task carries no run state, so a delivery does not block adoption', () => {
  assert.equal(sameDraftContent(baseDraft, { ...baseDraft, active: undefined }), true)
  assert.equal(sameDraftContent({ ...baseDraft, active: undefined }, baseDraft), true)
})
