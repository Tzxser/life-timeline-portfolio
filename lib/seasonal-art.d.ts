export type Season = 'spring' | 'summer' | 'autumn' | 'winter'
export interface SeasonBlend { from: Season | 'neutral'; to: Season | 'neutral'; mix: number }
export interface TreeInk { seed: number; height: number }
export interface TreeGeometry { h: number; w: number; tilt: number; season: SeasonBlend }
export function renderSeasonTree(entry: TreeInk, geometry: TreeGeometry): string
export function renderSeasonScene(options: { x: number; ground: number; season: Season; variant: number; scale: number; seed: number }): string
export function renderSeasonGround(options: { x: number; y: number; width: number; season: Season; seed: number }): string
