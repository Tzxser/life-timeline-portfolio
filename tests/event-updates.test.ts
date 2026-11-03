import assert from 'node:assert/strict'
import test from 'node:test'
import { makeDailyEntry, patchEventInDateOrder } from '../types/life-event'

test('body edits retain event identities and equal-date order without mutating the old snapshot', () => {
  const before = ['2026-10-01', '2026-10-02', '2026-10-02'].map((date, i) => ({ ...makeDailyEntry(date), id: `entry-${i}` }))
  const after = patchEventInDateOrder(before, 'entry-1', { content: '新正文', id: 'wrong-id' })
  assert.deepEqual(after.map((e) => e.id), before.map((e) => e.id))
  assert.equal(after[0], before[0])
  assert.equal(after[2], before[2])
  assert.notEqual(after[1], before[1])
  assert.equal(after[1].content, '新正文')
  assert.equal(before[1].content, '')
  assert.equal(patchEventInDateOrder(before, 'missing', { content: 'ignored' }), before)
})

test('date changes still move the complete edited event to its correct date', () => {
  const before = ['2026-10-01', '2026-10-02', '2026-10-03'].map((date, i) => ({ ...makeDailyEntry(date), id: `entry-${i}` }))
  const after = patchEventInDateOrder(before, 'entry-0', { date: '2026-10-04', content: '随日期移动' })
  assert.deepEqual(after.map((e) => e.id), ['entry-1', 'entry-2', 'entry-0'])
  assert.equal(after[2].content, '随日期移动')
  assert.equal(before[0].date, '2026-10-01')
})
