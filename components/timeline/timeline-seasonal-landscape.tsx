'use client'

import { memo, useId, useMemo } from 'react'
import type { SeasonalMonth } from '@/lib/seasonal-timeline'
import { renderSeasonGround, renderSeasonScene } from '@/lib/seasonal-art'
import { sceneScaleWithinTree, seasonalEasterEggsVisible } from '@/lib/seasonal-timeline'

interface Props {
  months: SeasonalMonth[]
  axisY: number
  windowStart: number
  windowEnd: number
  lengthScale: number
  /** Lower bound for the current viewport's smallest event tree. */
  treeHeightLimit: number
}

export const TimelineSeasonalLandscape = memo(function TimelineSeasonalLandscape({ months, axisY, windowStart, windowEnd, lengthScale, treeHeightLimit }: Props) {
  const id = useId().replaceAll(':', '')
  const width = windowEnd - windowStart
  const visible = useMemo(() => (
    seasonalEasterEggsVisible(lengthScale)
      ? months.filter(month => month.x + month.width >= windowStart - 80 && month.x <= windowEnd + 80)
      : []
  ), [months, windowStart, windowEnd, lengthScale])
  const artwork = useMemo(() => {
    let ink = '', lastScene = -Infinity
    for (const month of visible) {
      if (month.width <= 1) continue
      const { x, season, year } = month
      if (month.width >= 20) ink += renderSeasonGround({ x, y: axisY - 14, width: month.width, season, seed: year + month.month * 13 })
      const spacious = month.width >= 48
      const count = spacious ? Math.max(1, Math.min(3, Math.floor(month.width / 150))) : [1, 4, 7, 10].includes(month.month) ? 1 : 0
      for (let i = 0; i < count; i++) {
        const center = x + month.width * (i + .5) / count
        if (center - lastScene < 62) continue
        lastScene = center
        const scale = sceneScaleWithinTree(month.width >= 100 ? .88 : .7, treeHeightLimit)
        const variant = (month.month + 2 + i) % 4
        ink += `<g class="season-scene" data-season="${season}" style="color:var(--${season})"><ellipse class="scene-clearing" cx="${center}" cy="${axisY - 8}" rx="20" ry="7"/>${renderSeasonScene({ x: center, ground: axisY - 2, season, scale, variant, seed: year + month.month })}</g>`
      }
    }
    return ink
  }, [visible, axisY, treeHeightLimit])
  if (!seasonalEasterEggsVisible(lengthScale)) return null
  return (
    <svg className="lt-seasonal-landscape" data-seasonal-landscape="" aria-hidden="true" focusable="false" style={{ left: windowStart }} width={width} height={axisY + 12} viewBox={`${windowStart} 0 ${width} ${axisY + 12}`}>
      <defs>
        <linearGradient id={`${id}-seasons`} gradientUnits="userSpaceOnUse" x1={windowStart} x2={windowEnd}>
          {visible.map(month => <stop key={month.key} offset={`${Math.max(0, Math.min(100, (month.x + month.width / 2 - windowStart) / width * 100))}%`} style={{ stopColor: `var(--${month.season}-wash)` }} />)}
        </linearGradient>
        <linearGradient id={`${id}-fade`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="white" stopOpacity="0" /><stop offset=".8" stopColor="white" stopOpacity=".4" /><stop offset="1" stopColor="white" stopOpacity=".55" /></linearGradient>
        <mask id={`${id}-mask`}><rect x={windowStart} y={18} width={width} height={axisY - 6} fill={`url(#${id}-fade)`} /></mask>
      </defs>
      <rect x={windowStart} y={18} width={width} height={axisY - 6} fill={`url(#${id}-seasons)`} mask={`url(#${id}-mask)`} />
      <g dangerouslySetInnerHTML={{ __html: artwork }} />
    </svg>
  )
})
