export type LifeSeason = 'spring' | 'summer' | 'autumn' | 'winter'

export const SEASON_LABELS: Record<LifeSeason, string> = {
  spring: '春',
  summer: '夏',
  autumn: '秋',
  winter: '冬',
}

/**
 * Use the local calendar only.  The month boundaries keep the startup view
 * deterministic and avoid a network or location dependency in the desktop app.
 */
export function seasonForMonth(month: number): LifeSeason {
  const normalized = Math.min(12, Math.max(1, Math.trunc(month)))
  if (normalized >= 3 && normalized <= 5) return 'spring'
  if (normalized >= 6 && normalized <= 8) return 'summer'
  if (normalized >= 9 && normalized <= 11) return 'autumn'
  return 'winter'
}

export function seasonForDate(date: Date): LifeSeason {
  return seasonForMonth(date.getMonth() + 1)
}
