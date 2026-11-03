import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildRulerLayout,
  FIXED_TIMELINE_CLIP_BOTTOM,
  TIMELINE_AXIS_Y,
  TIMELINE_TRACK_HEIGHT,
  type RulerLayoutInput,
} from '../lib/timeline-ruler-layout'

const normal: RulerLayoutInput = {
  yearTickHeight: 44,
  monthTickHeight: 26,
  weekTickHeight: 16,
  yearLabelSize: 12,
  widthScale: 1,
}

test('ordinary ruler keeps its established tick sizes and label positions', () => {
  const layout = buildRulerLayout(normal)
  assert.deepEqual(layout.expanded, {
    yearHeight: 44, monthHeight: 26, weekHeight: 16,
    weekLabel: 19, monthLabel: 32, yearLabel: 48,
  })
  assert.deepEqual(layout.compact, layout.expanded)
})

test('reported 120 percent width and 72px year tick retract before the writing clip', () => {
  const layout = buildRulerLayout({
    ...normal, widthScale: 1.2, yearTickHeight: 72, monthTickHeight: 31, weekTickHeight: 22,
  })
  const compactClip = TIMELINE_TRACK_HEIGHT + 16 + 42 - FIXED_TIMELINE_CLIP_BOTTOM
  const originalBottom = TIMELINE_AXIS_Y + 72 * 1.2 + 4 * 1.2 + 18
  assert(originalBottom > compactClip, 'This fixture must reproduce the old clipped year')
  assert.equal(layout.expanded.yearHeight, 72 * 1.2, 'This common expanded setting fits without reduction')
  assert(TIMELINE_AXIS_Y + layout.compact.yearLabel + layout.yearLineHeight <= compactClip - 8)
})

test('all supported ruler extremes keep readable year text within both endpoints and transition', () => {
  for (const widthScale of [.7, 1, 1.2, 1.5, 1.8]) {
    for (const yearTickHeight of [24, 36, 44, 48, 72]) {
      for (const monthTickHeight of [14, 26, 36, 48].filter(n => n <= yearTickHeight)) {
        for (const weekTickHeight of [8, 16, 26, 36].filter(n => n <= monthTickHeight)) {
          for (const yearLabelSize of [10, 12, 16]) {
            const settings = { widthScale, yearTickHeight, monthTickHeight, weekTickHeight, yearLabelSize }
            const { expanded, compact, expandedBottom, compactBottom, yearLineHeight } = buildRulerLayout(settings)
            const detail = JSON.stringify(settings)
            assert(expanded.yearHeight >= expanded.monthHeight && expanded.monthHeight >= expanded.weekHeight, detail)
            assert(expanded.weekHeight > 0, detail)
            for (const p of [0, .1, .25, .5, .75, .9, 1]) {
              const mix = (start: number, end: number) => start + (end - start) * p
              const yearLabel = mix(expanded.yearLabel, compact.yearLabel)
              const monthLabel = mix(expanded.monthLabel, compact.monthLabel)
              const weekLabel = mix(expanded.weekLabel, compact.weekLabel)
              const yearEnd = mix(expanded.yearHeight, compact.yearHeight)
              const bottom = mix(expandedBottom, compactBottom)
              assert(TIMELINE_AXIS_Y + yearLabel + yearLineHeight <= bottom + 1e-8, detail)
              assert(yearLabel >= yearEnd, detail)
              assert(yearLabel >= monthLabel + 15 - 1e-8, detail)
              assert(monthLabel >= weekLabel + 13 - 1e-8, detail)
            }
          }
        }
      }
    }
  }
})

test('overview tick settings never alter the compact endpoint or fixed track height', () => {
  const large = buildRulerLayout({ ...normal, widthScale: 1.8, yearTickHeight: 72, monthTickHeight: 48, weekTickHeight: 36 })
  const small = buildRulerLayout({ ...normal, widthScale: .7, yearTickHeight: 24, monthTickHeight: 14, weekTickHeight: 8 })
  assert.deepEqual(large.compact, small.compact)
  assert.equal(TIMELINE_TRACK_HEIGHT, 288)
})
