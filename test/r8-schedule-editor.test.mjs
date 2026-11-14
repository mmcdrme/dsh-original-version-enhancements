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

test('a monthly rule in the Host form opens in the guided form', () => {
  // The Host's own "monthly" is "that day or the month's last day"; only this
  // exact shape is claimed by the guided form.
  assert.equal(editor.repeatKindOf({ kind: 'rrule', rrule: ruleOf('FREQ=MONTHLY;BYMONTHDAY=5,-1;BYSETPOS=1') }), 'monthly')
  assert.equal(editor.repeatKindOf({ kind: 'rrule', rrule: ruleOf('FREQ=MONTHLY;BYMONTHDAY=31,-1;BYSETPOS=1') }), 'monthly')
})

test('a monthly rule with extra clauses keeps the raw editor', () => {
  // The older plugin shape (a bare BYMONTHDAY) is not claimed: rewriting it into
  // the month-end form on save would change when it fires.
  assert.equal(editor.repeatKindOf({ kind: 'rrule', rrule: ruleOf('FREQ=MONTHLY;BYMONTHDAY=5') }), 'rrule')
  assert.equal(editor.repeatKindOf({ kind: 'rrule', rrule: ruleOf('FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=5,-1;BYSETPOS=1') }), 'rrule')
  assert.equal(editor.repeatKindOf({ kind: 'rrule', rrule: ruleOf('FREQ=MONTHLY;BYMONTHDAY=5,-1;BYSETPOS=1;UNTIL=20261231T000000Z') }), 'rrule')
  assert.equal(editor.repeatKindOf({ kind: 'rrule', rrule: ruleOf('FREQ=MONTHLY;BYMONTHDAY=5,-1') }), 'rrule')
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

const { monthDayOf } = new Function(`${slice('    const monthDayOf = ', '    const WORKDAYS = ')}
return { monthDayOf }`)()

test('the monthly form writes the Host convention and reads it back', () => {
  const timing = timingOfDraft({
    kind: 'monthly', monthDay: '31', weekdays: [], weekday: 1, time: '09:00', interval: '1',
    delayUnit: 'min', date: '2026-01-01', rrule: '', cron: '0 9 * * *',
  })
  assert.equal(timing.kind, 'rrule')
  assert.match(timing.rrule, /RRULE:FREQ=MONTHLY;BYMONTHDAY=31,-1;BYSETPOS=1$/u)
  assert.equal(monthDayOf(timing.rrule), 31)
})

test('a stored Sunday survives the editor round-trip', () => {
  const timing = timingOfDraft({
    kind: 'weekly', weekdays: [7], weekday: 7, time: '09:00', interval: '1',
    delayUnit: 'min', date: '2026-01-01', monthDay: '1', rrule: '', cron: '0 9 * * *',
  })
  assert.deepEqual(timing.weekly.weekdays, [7])
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

const { toggleWeekday } = new Function(`${slice('    const toggleWeekday = ', '    /**\n     * Turn an editor draft into a Host timing request.')}
return { toggleWeekday }`)()

test('a selected weekday can be removed while another one keeps the rule alive', () => {
  assert.deepEqual(toggleWeekday([1, 3], 1), [3])
  assert.deepEqual(toggleWeekday([1, 2, 5], 5), [1, 2])
})

test('the last selected weekday refuses to be removed', () => {
  const only = [3]
  assert.equal(toggleWeekday(only, 3), only, 'the same selection must come back')
  assert.deepEqual(toggleWeekday(only, 3), [3])
})

test('adding a weekday keeps the selection sorted', () => {
  assert.deepEqual(toggleWeekday([5], 1), [1, 5])
  assert.deepEqual(toggleWeekday([], 2), [2])
  assert.deepEqual(toggleWeekday([6, 7], 3), [3, 6, 7])
})

test('Sunday is a real ISO weekday, not an out-of-range day', () => {
  // The Host numbers weekdays 1 = Monday … 7 = Sunday; the panel used 0-based
  // numbering, so Sunday could not be created and a stored one became Monday.
  assert.deepEqual(toggleWeekday([1], 7), [1, 7])
  assert.deepEqual(toggleWeekday([7], 1), [1, 7])
  const onlySunday = [7]
  assert.equal(toggleWeekday(onlySunday, 7), onlySunday, 'the last day is locked in place')
})

test('an out-of-range day changes nothing', () => {
  assert.deepEqual(toggleWeekday([1], -1), [1])
  assert.deepEqual(toggleWeekday([1], 0), [1])
  assert.deepEqual(toggleWeekday([1], 8), [1])
  assert.deepEqual(toggleWeekday([1], 1.5), [1])
  assert.deepEqual(toggleWeekday(undefined, 1), [1])
})
