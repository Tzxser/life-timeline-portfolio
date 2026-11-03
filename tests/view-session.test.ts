import assert from 'node:assert/strict'
import test from 'node:test'
import { makeDailyEntry, type LifeEvent } from '../types/life-event'
import { normalizeViewSession, resolveViewSession, type ViewSession } from '../lib/view-session'

const session: ViewSession = { version: 1, localDate: '2026-10-13', selectedId: 'old', draft: null, scrollY: 480,
  timelineCenter: 2026.7, pickedStageId: 'stage', headerCollapsed: true }
const events: LifeEvent[] = [
  { ...makeDailyEntry('2026-10-01'), id: 'old' },
  { ...makeDailyEntry('2026-10-14'), id: 'today' },
]

test('same local day restores the actual selected diary and exact reading offset', () => {
  const restore = resolveViewSession(session, events, new Date(2026, 9, 13, 23, 59))
  assert.deepEqual(restore, { selectedId: 'old', draft: null, newDay: false, scrollY: 480 })
})
test('next day selects existing daily entry without creating duplicate or changing preferences', () => {
  assert.deepEqual(resolveViewSession(session, events, new Date(2026, 9, 14, 0, 1)), { selectedId: 'today', draft: null, newDay: true, scrollY: 0 })
  assert.equal(session.headerCollapsed, true)
  assert.equal(events.length, 2)
})
test('new day without a diary produces only a draft; active old empty draft is never carried into the new date', () => {
  const input = { ...session, selectedId: null, draft: { date: '2026-10-13', title: '未落地草稿', importance: 3 } }
  const restore = resolveViewSession(input, events, new Date(2026, 9, 15, 10))
  assert.equal(restore.selectedId, null)
  assert.equal(restore.draft?.date, '2026-10-15')
  assert.equal(restore.draft?.title, '2026-10-15 日记')
  assert.equal(events.length, 2)
  assert.equal(resolveViewSession(input, events, new Date(2026, 9, 13)).draft?.title, '未落地草稿')
})
test('deleted selections, legacy versions and corrupt positions fall back safely', () => {
  assert.equal(resolveViewSession({ ...session, selectedId: 'gone' }, events, new Date(2026, 9, 13)).selectedId, null)
  assert.equal(normalizeViewSession({ ...session, localDate: '2026-02-31' }), null)
  assert.equal(normalizeViewSession({ ...session, version: 99 }), null)
  assert.equal(normalizeViewSession(null), null)
  const safe = normalizeViewSession({ ...session, scrollY: Infinity, timelineCenter: NaN, headerCollapsed: 'yes' })!
  assert.equal(safe.scrollY, 0)
  assert.equal(safe.timelineCenter, null)
  assert.equal(safe.headerCollapsed, false)
})
