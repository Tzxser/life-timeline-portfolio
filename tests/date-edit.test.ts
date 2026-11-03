import assert from 'node:assert/strict'
import test from 'node:test'
import { dateEditPatch, eventDateValue, hasDateChange, validateDateEdit } from '../lib/date-edit'
import { makeDailyEntry, type LifeEvent } from '../types/life-event'

const daily: LifeEvent = { ...makeDailyEntry('2026-10-01'), id: 'daily-a', title: '2026-10-01 日记' }

test('a date draft detects a reverted value and display or precision-only changes', () => {
  const original = eventDateValue(daily)
  assert.equal(hasDateChange(original, { ...original }), false)
  assert.equal(hasDateChange(original, { ...original, date: '2026-10-02' }), true)
  assert.equal(hasDateChange(original, { ...original, displayDate: '国庆当天' }), true)
  assert.equal(hasDateChange(original, { ...original, datePrecision: 'month' }), true)
})

test('daily date validation rejects duplicates while allowing the current record and non-daily events', () => {
  const original = eventDateValue(daily)
  assert.equal(validateDateEdit(daily, original, [daily]), null)
  assert.equal(validateDateEdit(daily, original, [{ ...daily, id: 'ordinary', type: 'event' }]), null)
  assert.match(validateDateEdit(daily, original, [{ ...daily, id: 'another-daily' }]) ?? '', /已经有一篇日记/)
  assert.match(validateDateEdit(daily, { ...original, date: '2026-10', datePrecision: 'month' }) ?? '', /精确日期/)
})

test('date drafts reject incomplete dates, invalid days and years beyond the native database range', () => {
  for (const date of ['', '2026-10', '2026-2-1', '2026-02-29', '1900-02-29', '2026-04-31', '2026-13-01', '0000-01-01', '10000-01-01']) {
    assert.notEqual(validateDateEdit(daily, { ...eventDateValue(daily), date }), null, date)
  }
  for (const date of ['2024-02-29', '2000-02-29', '0001-01-01', '9999-12-31']) {
    assert.equal(validateDateEdit(daily, { ...eventDateValue(daily), date }), null, date)
  }
})

test('ordinary records preserve fuzzy dates but require a valid estimate and a description', () => {
  const event: LifeEvent = { ...daily, type: 'event' }
  assert.equal(validateDateEdit(event, { date: '2026-10', displayDate: '2026 年 10 月', datePrecision: 'month' }), null)
  assert.equal(validateDateEdit(event, { date: '2026', displayDate: '2026 年秋天', datePrecision: 'approx' }), null)
  assert.notEqual(validateDateEdit(event, { date: '2026-00', displayDate: '月份', datePrecision: 'month' }), null)
  assert.notEqual(validateDateEdit(event, { date: '2026', displayDate: ' ', datePrecision: 'stage' }), null)
})

test('confirmed date patches update only exact generated daily titles and preserve user titles and content', () => {
  const draft = { date: '2026-10-02', displayDate: '2026 年 10 月 2 日', datePrecision: 'day' as const }
  assert.deepEqual(dateEditPatch(daily, draft), { ...draft, title: '2026-10-02 日记' })
  for (const title of ['我的国庆', '2026-10-1日记', '今天']) {
    assert.deepEqual(dateEditPatch({ ...daily, title, content: '正文不能被改动' }, draft), draft)
  }
  assert.deepEqual(dateEditPatch({ ...daily, type: 'event' }, draft), draft)
  assert.deepEqual(dateEditPatch(daily, eventDateValue(daily)), eventDateValue(daily))
})
