import type { LifeEvent } from '@/types/life-event'
import type { Season, SeasonBlend, TreeGeometry, TreeInk } from './seasonal-art'
import { parseEventDate, yearFraction, type TimelineGeometry } from './timeline-geometry'

export const SEASONS: Season[] = ['spring', 'summer', 'autumn', 'winter']

/**
 * Landscape scenes are small easter eggs rather than part of the core ruler.
 * Keep them out of the wide overview so the timeline stays quiet until the
 * user is close enough to appreciate the line art.
 */
export const SEASONAL_EASTER_EGG_ZOOM = 1.54

/** The tallest scene drawing in `seasonal-art.js`, measured from its ground. */
export const SEASONAL_SCENE_ART_HEIGHT = 40

export function seasonalEasterEggsVisible(lengthScale: number): boolean {
  return Number.isFinite(lengthScale) && lengthScale > SEASONAL_EASTER_EGG_ZOOM
}

/** Keep every scene no taller than the smallest seasonal tree in the viewport. */
export function sceneScaleWithinTree(baseScale: number, treeHeightLimit: number): number {
  if (!Number.isFinite(treeHeightLimit) || treeHeightLimit <= 0) return baseScale
  return Math.min(baseScale, treeHeightLimit / SEASONAL_SCENE_ART_HEIGHT)
}

export function monthSeason(month: number): Season {
  return month >= 3 && month <= 5 ? 'spring' : month >= 6 && month <= 8 ? 'summer' : month >= 9 && month <= 11 ? 'autumn' : 'winter'
}

/** Unknown/estimated dates never acquire a made-up season or precise day. */
export function eventSeason(event: Pick<LifeEvent, 'date' | 'datePrecision'>): SeasonBlend {
  const { year, month, day } = parseEventDate(event.date)
  if (!month || !['day', 'month'].includes(event.datePrecision)) return { from: 'neutral', to: 'neutral', mix: 1 }
  const season = monthSeason(month)
  if (!day || event.datePrecision !== 'day') return { from: season, to: season, mix: 1 }
  const time = Date.UTC(year, month - 1, day)
  for (const [boundary, next] of [[2, 'spring'], [5, 'summer'], [8, 'autumn'], [11, 'winter']] as const) {
    const distance = (time - Date.UTC(year, boundary, 1)) / 86_400_000
    if (Math.abs(distance) <= 12) {
      const t = (distance + 12) / 24
      return { from: SEASONS[(SEASONS.indexOf(next) + 3) % 4], to: next, mix: t * t * (3 - 2 * t) }
    }
  }
  return { from: season, to: season, mix: 1 }
}

export function seasonColor(blend: SeasonBlend): string {
  if (blend.to === 'neutral') return 'var(--tlc-node)'
  if (blend.from === blend.to) return `var(--${blend.to})`
  return `color-mix(in srgb, var(--${blend.from}) ${(1 - blend.mix) * 100}%, var(--${blend.to}))`
}

/** Trees fit the existing event stem; label rows and day-bucket hit zones stay intact. */
export function seasonalTree(event: LifeEvent, availableHeight: number, v: number): { ink: TreeInk; geometry: TreeGeometry; color: string } {
  const { month, day } = parseEventDate(event.date)
  const seed = (month ?? 6) * 103 + (day ?? 15) * 17
  const importance = Math.max(1, Math.min(5, Math.round(event.importance)))
  const season = eventSeason(event)
  const scales = { spring: .7, summer: 1.06, autumn: 1, winter: .92, neutral: .92 }
  const scale = scales[season.from] * (1 - season.mix) + scales[season.to] * season.mix
  const desired = [25, 34, 43, 56, 67][importance - 1] * v * scale
  const h = Math.max(8, Math.min(availableHeight - 7, desired))
  const w = [8, 11, 15, 19, 23][importance - 1] * Math.min(1.2, h / desired) * (season.to === 'spring' ? .72 : 1)
  return { ink: { seed, height: importance <= 2 ? 0 : importance === 3 ? 1 : 2 }, geometry: { h, w, tilt: ((seed % 11) - 5) * .55, season }, color: seasonColor(season) }
}

export interface SeasonalMonth { key: string; year: number; month: number; x: number; width: number; season: Season }
/** Uses the existing non-linear calendar mapping, including widened busy months. */
export function seasonalMonths(geometry: TimelineGeometry): SeasonalMonth[] {
  return geometry.yearSegments.flatMap(({ year }) => Array.from({ length: 12 }, (_, index) => {
    const month = index + 1
    const x = geometry.yearToX(year + yearFraction(year, month, 1))
    const end = month === 12 ? geometry.yearToX(year + 1) : geometry.yearToX(year + yearFraction(year, month + 1, 1))
    return { key: `${year}-${month}`, year, month, x, width: Math.max(0, end - x), season: monthSeason(month) }
  }))
}
