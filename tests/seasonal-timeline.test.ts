import assert from 'node:assert/strict'
import test from 'node:test'
import {
  eventSeason,
  sceneScaleWithinTree,
  seasonalEasterEggsVisible,
  seasonalMonths,
  seasonalTree,
} from '../lib/seasonal-timeline'
import { renderSeasonTree } from '../lib/seasonal-art'
import { buildTimelineGeometry, yearFraction } from '../lib/timeline-geometry'
import type { TimelineSettings } from '../lib/timeline-settings'
import type { LifeEvent } from '../types/life-event'

const event: LifeEvent = { id: 'synthetic', title: '合成日记', date: '2026-07-18', displayDate: '2026 年 7 月 18 日', datePrecision: 'day', importance: 4, stageId: null, summary: '', content: '' }
const settings: TimelineSettings = { baseYearWidth: 160, expansionRatio: .1, yearTickHeight: 44, monthTickHeight: 26, weekTickHeight: 16, dayTickHeight: 9, axisStrokeWidth: 1, tickStrokeWidth: 1, yearLabelSize: 12, eventLabelSize: 13, lengthScale: 1, widthScale: 1, colorIntensity: 1, timelineTint: '', colors: { axis: '', yearTick: '', monthTick: '', weekTick: '', dayTick: '', selected: '', stageBand: '' }, visibility: { months: true, weeks: true, days: true, stageBands: true }, timelineCollapsed: false, timelineStyle: 'seasons' }

test('imprecise dates keep neutral trees instead of inventing a season', () => {
  for (const datePrecision of ['year', 'approx', 'stage', 'unknown'] as const) {
    const model = seasonalTree({ ...event, datePrecision }, 60, 1)
    assert.equal(model.geometry.season.to, 'neutral')
    assert(!/tree-leaf|tree-fruit|snow-top/.test(renderSeasonTree(model.ink, model.geometry)))
  }
  assert.deepEqual(eventSeason({ date: '2026-04', datePrecision: 'month' }), { from: 'spring', to: 'spring', mix: 1 })
})

test('season transitions follow calendar days including leap years', () => {
  const before = eventSeason({ date: '2028-02-29', datePrecision: 'day' })
  const boundary = eventSeason({ date: '2028-03-01', datePrecision: 'day' })
  assert.equal(before.from, 'winter')
  assert.equal(boundary.to, 'spring')
  assert(before.mix < boundary.mix)
  assert.equal(boundary.mix, .5)
  assert.equal(eventSeason({ date: '2026-12-31', datePrecision: 'day' }).to, 'winter')
  assert.equal(eventSeason({ date: '2027-01-01', datePrecision: 'day' }).to, 'winter')
})

test('painted months align with the existing widened calendar, without mutating it', () => {
  const events = Array.from({ length: 20 }, (_, index) => ({ ...event, id: `busy-${index}`, date: `2028-02-${String(index + 1).padStart(2, '0')}` }))
  const geometry = buildTimelineGeometry(events, 2028, 2029, settings, 1, 200)
  const originalAnchors = JSON.stringify(geometry.eventAnchors)
  const months = seasonalMonths(geometry)
  const feb = months.find(month => month.year === 2028 && month.month === 2)!
  const march = months.find(month => month.year === 2028 && month.month === 3)!
  assert.equal(feb.x, geometry.yearToX(2028 + yearFraction(2028, 2, 1)))
  assert.equal(feb.x + feb.width, march.x)
  assert(feb.width > march.width, 'Busy February must retain the real geometry expansion')
  assert.equal(JSON.stringify(geometry.eventAnchors), originalAnchors)
})

test('tree art fits its original stem and stays stable across rendering', () => {
  for (const v of [.7, 1, 1.8]) for (const importance of [1, 2, 3, 4, 5]) {
    const model = seasonalTree({ ...event, importance, date: '2026-12-21' }, 65 * v, v)
    assert(model.geometry.h + 7 <= 65 * v)
    assert.equal(renderSeasonTree(model.ink, model.geometry), renderSeasonTree(model.ink, model.geometry))
    assert(!/NaN|Infinity/.test(renderSeasonTree(model.ink, model.geometry)))
  }
})

test('seasonal easter eggs stay hidden until the close-up threshold', () => {
  assert.equal(seasonalEasterEggsVisible(1.54), false)
  assert.equal(seasonalEasterEggsVisible(1.539), false)
  assert.equal(seasonalEasterEggsVisible(1.541), true)
  assert.equal(seasonalEasterEggsVisible(Number.NaN), false)
})

test('seasonal easter egg scale never exceeds the smallest tree height', () => {
  assert.equal(sceneScaleWithinTree(.88, 40), .88)
  assert.equal(sceneScaleWithinTree(.88, 20), .5)
  assert.equal(sceneScaleWithinTree(.7, 8), .2)
  assert.equal(sceneScaleWithinTree(.7, 0), .7)
})
