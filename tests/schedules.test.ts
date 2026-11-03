import test from 'node:test'
import assert from 'node:assert/strict'
import { schoolWeekOne, entriesOn, makeCard, sourceGrid, mergeGrid, cardView, validateSource, validCard, clone, SCHEDULE_NODE, type ScheduleSource } from '../lib/schedules/model'
import { parseText, parseJson, parseMatrix, parseWeeks } from '../lib/schedules/parse'
import { makeScheduleUndo, rollbackSchedules, undoHasLaterChanges } from '../lib/schedules/undo'
import { docHasSubstance, eventSearchText } from '../lib/rich-content'
import { makeDailyEntry } from '../types/life-event'

const source: ScheduleSource = {
  id: 'term-a', name: '合成课表', version: 'v1', updatedAt: '2026-10-16T00:00:00Z', device: '电脑',
  weekOne: '2026-08-31', startDate: '2026-08-31', endDate: '2027-01-03',
  entries: [{ id: 'math', title: '数学', weekday: 5, weeks: [7, 9], time: '1-2节', location: 'A101', notes: '' }],
}
test('current school week is anchored once and survives a calendar-year boundary', () => {
  assert.equal(schoolWeekOne('2026-10-16', 7), '2026-08-31')
  assert.equal(schoolWeekOne('2027-01-03', 18), '2026-08-31')
  assert.equal(entriesOn(source, '2026-10-16').length, 1)
  assert.equal(entriesOn(source, '2026-10-23').length, 0)
  assert.equal(entriesOn(source, '2026-10-30').length, 1)
  assert.equal(entriesOn(source, '2027-01-08').length, 0)
})
test('week ranges including odd/even weeks and clear text/JSON parse locally', () => {
  assert.deepEqual(parseWeeks('1-8单周'), [1, 3, 5, 7])
  assert.deepEqual(parseWeeks('第2至8双周'), [2, 4, 6, 8])
  const text = parseText('2026-10-17 08:00-09:00 高等数学 地点：A101\n周五 1-2节 操作系统 1-16周\n无法确定时间的说明')
  assert.equal(text.entries.length, 2); assert.equal(text.entries[0].location, 'A101')
  assert.equal(text.entries[1].weekday, 5); assert.equal(text.entries[1].weeks?.length, 16)
  assert.equal(text.warnings.length, 1)
  const json = parseJson(JSON.stringify({ data: [{ 事项: '会议', 日期: '2026/10/17', 时间: '14:00', 地点: '线上' }, { title: '不猜日期' }] }))
  assert.equal(json.entries.length, 1); assert.equal(json.entries[0].date, '2026-10-17'); assert.equal(json.warnings.length, 1)
  const english = parseText('Monday 08:00-09:00 Synthetic seminar\nMarch 14, 2024 10:00-11:00 Synthetic workshop')
  assert.equal(english.entries.length, 2); assert.equal(english.entries[0].weekday, 1); assert.equal(english.entries[1].date, '2024-03-14')
})
test('weekday matrices retain separate courses sharing a period in different weeks', () => {
  const parsed = parseMatrix([['节次', '星期一', '星期二', '星期三'], ['1、2', 'I04ABC_04 数学\n(1-8周) A101\nI04DEF_05 物理\n(9-16周) A102', '', '英语']])
  assert.equal(parsed.entries.length, 3)
  assert.deepEqual(parsed.entries[1].weeks, [9, 10, 11, 12, 13, 14, 15, 16])
  assert.equal(parsed.entries[2].weekday, 3)
})
test('each insertion has an independent identity, including duplicate dates', () => {
  const one = makeCard(source, '2026-10-16'), two = makeCard(source, '2026-10-16')
  assert.notEqual(one.id, two.id); one.local.rows[0].cells.notes = '只改第一张'
  assert.equal(two.local.rows[0].cells.notes, '')
  assert.equal(validCard(one), true)
  const week = sourceGrid(source, '2026-10-12', '2026-10-18', 'week')
  assert.match(week.rows[0].cells['2026-10-16'], /数学/)
  assert.throws(() => makeCard(source, '2026-10-12', '2026-10-20', 'week'))
})
test('unmodified source fields update while per-card notes, added rows and columns survive', () => {
  const card = makeCard(source, '2026-10-16')
  card.local.rows[0].cells.notes = '已完成作业'
  card.local.columns.push({ id: 'custom', label: '完成情况' }); card.local.rows[0].cells.custom = '完成'
  card.local.rows.push({ id: 'private-row', cells: { title: '晚间运动' } })
  const updated = clone(source); updated.version = 'v2'; updated.entries[0].location = 'B202'
  const result = cardView(card, updated)
  assert.equal(result.conflicts.length, 0)
  assert.equal(result.grid.rows[0].cells.location, 'B202'); assert.equal(result.grid.rows[0].cells.notes, '已完成作业')
  assert.equal(result.grid.rows[1].cells.title, '晚间运动'); assert.equal(result.grid.rows[0].cells.custom, '完成')
})
test('same-cell concurrent edits require explicit choice and never silently discard the local edit', () => {
  const card = makeCard(source, '2026-10-16'); card.local.rows[0].cells.location = '线上'
  const updated = clone(source); updated.version = 'v2'; updated.entries[0].location = 'B202'
  const conflict = cardView(card, updated)
  assert.equal(conflict.conflicts.length, 1); assert.equal(conflict.grid.rows[0].cells.location, '线上')
  assert.equal(cardView(card, updated, { [conflict.conflicts[0].id]: 'incoming' }).grid.rows[0].cells.location, 'B202')
  assert.equal(cardView(card, updated, { [conflict.conflicts[0].id]: 'local' }).conflicts.length, 0)
})
test('deleting locally or upstream is a conflicting edit when the other side changed the row', () => {
  const base = sourceGrid(source, '2026-10-16', '2026-10-16', 'list'), local = clone(base), incoming = clone(base)
  local.rows = []; incoming.rows[0].cells.location = 'B202'
  assert.equal(mergeGrid(base, local, incoming).conflicts.length, 1)
  local.rows = clone(base.rows); local.rows[0].cells.notes = '自定义'; incoming.rows = []
  assert.equal(mergeGrid(base, local, incoming).grid.rows[0].cells.notes, '自定义')
  assert.equal(mergeGrid(base, local, incoming).conflicts.length, 1)
})
test('undo restores only affected schedules and cards, preserving subsequent diary prose', () => {
  const card = makeCard(source, '2026-10-16'), oldNode = { type: SCHEDULE_NODE, attrs: { card } }
  const next = clone(source); next.version = 'v2'; next.entries[0].location = 'B202'
  const incoming = clone(oldNode); incoming.attrs.card.local.rows[0].cells.notes = '传入修改'
  const event = { ...makeDailyEntry('2026-10-16'), id: 'daily-test', content: '后来写下的文字', richContent: { version: 1 as const, format: 'tiptap-json' as const, doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '后来写下的文字' }] }, incoming] } } }
  const undo = { ...makeScheduleUndo([source], [next]), cardsBefore: [{ date: event.date, index: 1, node: oldNode }], cardIds: [card.id], afterCards: [incoming], afterCardRefs: [{ date: event.date, index: 1, node: incoming }] }
  assert.equal(undoHasLaterChanges(undo, [next], [event]), false)
  const unrelated = { ...clone(source), id: 'other' }
  const restored = rollbackSchedules(undo, [next, unrelated], [event])
  assert.equal(restored.schedules.find(s => s.id === source.id)?.entries[0].location, 'A101')
  assert.equal(restored.schedules.some(s => s.id === 'other'), true)
  assert.equal(restored.events[0].richContent?.doc.content?.[0].content?.[0].text, '后来写下的文字')
  assert.deepEqual(restored.events[0].richContent?.doc.content?.[1], oldNode)
  assert.deepEqual(restored.schedules.map(s => s.id), [source.id, unrelated.id])
})
test('rollback notices and removes a later card linked to the imported source', () => {
  const first = makeCard(source, '2026-10-16'), event = { ...makeDailyEntry('2026-10-16'), id: 'daily-later', content: '', richContent: { version: 1 as const, format: 'tiptap-json' as const, doc: { type: 'doc', content: [{ type: SCHEDULE_NODE, attrs: { card: first } }] } } }
  const undo = makeScheduleUndo([], [source], [])
  const later = makeCard(source, '2026-10-16'); event.richContent!.doc.content!.push({ type: SCHEDULE_NODE, attrs: { card: later } })
  assert.equal(undoHasLaterChanges(undo, [source], [event]), true)
  assert.equal(rollbackSchedules(undo, [source], [event]).events[0].richContent!.doc.content!.length, 0)
})
test('schedule-only diary counts as content and is searchable; malformed data is rejected', () => {
  const card = makeCard(source, '2026-10-16'), doc = { type: 'doc', content: [{ type: SCHEDULE_NODE, attrs: { card } }] }
  assert.equal(docHasSubstance(doc), true)
  const event = { ...makeDailyEntry('2026-10-16'), id: 'd', richContent: { version: 1 as const, format: 'tiptap-json' as const, doc } }
  assert.match(eventSearchText(event), /数学/)
  assert.throws(() => validateSource({ ...source, endDate: '2026-02-31' }))
  assert.throws(() => validateSource({ ...source, entries: [source.entries[0], source.entries[0]] }))
  assert.equal(validCard({ ...card, local: { ...card.local, columns: [{ id: '__proto__', label: 'bad' }] } }), false)
})
