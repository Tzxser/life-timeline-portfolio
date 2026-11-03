'use client'

// 时间轴缩放逻辑,独立封装,方便后续替换为更复杂的时间轴算法

import { useCallback, useState } from 'react'

export const BASE_PX_PER_YEAR = 160
// 下限放宽到 0.25,使「全部」能把几十年的人生完整装进窄窗口
export const MIN_ZOOM = 0.25
export const MAX_ZOOM = 3

export interface TimelineZoom {
  zoom: number
  pxPerYear: number
  /** 以容器内某个横坐标为焦点进行缩放,返回新旧 zoom,供调用方修正 scrollLeft */
  setZoomAt: (nextZoom: number, apply: (oldZoom: number, newZoom: number) => void) => void
  zoomIn: (apply: (oldZoom: number, newZoom: number) => void) => void
  zoomOut: (apply: (oldZoom: number, newZoom: number) => void) => void
  /** 直接设定缩放(用于 fit),返回被 clamp 后的实际值 */
  setZoomTo: (nextZoom: number) => number
  clampZoom: (nextZoom: number) => number
}

function clamp(z: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))
}

export function useTimelineZoom(initial = 1): TimelineZoom {
  const [zoom, setZoom] = useState(initial)

  const setZoomAt = useCallback((nextZoom: number, apply: (o: number, n: number) => void) => {
    setZoom((old) => {
      const next = clamp(nextZoom)
      if (next !== old) apply(old, next)
      return next
    })
  }, [])

  const zoomIn = useCallback(
    (apply: (o: number, n: number) => void) => {
      setZoom((old) => {
        const next = clamp(Math.round((old + 0.25) * 100) / 100)
        if (next !== old) apply(old, next)
        return next
      })
    },
    [],
  )

  const zoomOut = useCallback(
    (apply: (o: number, n: number) => void) => {
      setZoom((old) => {
        const next = clamp(Math.round((old - 0.25) * 100) / 100)
        if (next !== old) apply(old, next)
        return next
      })
    },
    [],
  )

  const setZoomTo = useCallback((nextZoom: number) => {
    const next = clamp(nextZoom)
    setZoom(next)
    return next
  }, [])

  return {
    zoom,
    pxPerYear: BASE_PX_PER_YEAR * zoom,
    setZoomAt,
    zoomIn,
    zoomOut,
    setZoomTo,
    clampZoom: clamp,
  }
}
