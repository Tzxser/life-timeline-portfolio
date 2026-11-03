'use client'

// 左右边缘导航:鼠标靠近时间轴下方区域的左 / 右边缘时,淡入对应一侧的竖条。
//
//   · 感应范围 = 应用可视区域左右各一条窄带,纵向从时间轴顶部的“当前可见下边界”
//     一直到视口底部。时间轴、顶栏、阶段栏与缩放控件里都不会触发。
//   · 感应只靠一个轻量的 pointermove 监听,不铺任何透明遮挡层 ——
//     正文点击、文字选择、拖入文件都不受影响;只有真正显现的窄竖条接收点击。
//   · 悬停只显示,点击才翻篇。上一篇 / 下一篇在点击那一刻按最新状态重新计算。

import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { formatCompactDate, type LifeEvent } from '@/types/life-event'
import { useNoHover } from '@/lib/overlay-registry'
import { cn } from '@/lib/utils'

export interface AdjacentRecords {
  prev: LifeEvent | null
  next: LifeEvent | null
}

type Side = 'left' | 'right'

interface EdgeNavigationProps {
  /** 有真实记录且没有任何遮罩打开时才启用 */
  enabled: boolean
  /** 时间轴顶部区域当前可见下边界(视口坐标,px)。只读,用于确定感应带 */
  getTopBoundary: () => number
  /** 按“当前最新状态”计算相邻记录 */
  resolveTargets: () => AdjacentRecords
  /** 选中对象 / 草稿变化的标识,用于刷新已显现按钮上的目标提示 */
  selectionKey: string
  onNavigate: (id: string) => void
}

const ZONE = 64 // 左右感应带宽度
const STRIP_WIDTH = 40 // 只占用正文外侧窄边,整条都可以点击
const HIDE_DELAY = 200
const HINT_DURATION = 1800

const BOUNDARY_TEXT: Record<Side, string> = {
  left: '已经是最早的一篇了',
  right: '已经是最新的一篇了',
}

export function EdgeNavigation({
  enabled,
  getTopBoundary,
  resolveTargets,
  selectionKey,
  onNavigate,
}: EdgeNavigationProps) {
  const touch = useNoHover()
  const [hoverSide, setHoverSide] = useState<Side | null>(null)
  const [focusSide, setFocusSide] = useState<Side | null>(null)
  const [targets, setTargets] = useState<AdjacentRecords>({ prev: null, next: null })
  const [region, setRegion] = useState({ top: 0, height: 0 })
  const [dragging, setDragging] = useState(false)
  const [hint, setHint] = useState<Side | null>(null)

  const navRef = useRef<HTMLElement>(null)
  const suppressPointerClick = useRef(false)
  const hoverSideRef = useRef<Side | null>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const latest = useRef({ getTopBoundary, resolveTargets })
  useEffect(() => {
    latest.current = { getTopBoundary, resolveTargets }
  })

  /** 长条始终局限在时间轴可见底边与视口底部之间,极矮窗口也不溢出。 */
  const placeStrips = useCallback(() => {
    const viewportHeight = document.documentElement.clientHeight
    const boundary = latest.current.getTopBoundary()
    const top = Math.min(viewportHeight, Math.max(0, Number.isFinite(boundary) ? boundary : viewportHeight))
    const height = viewportHeight - top
    setRegion((current) => current.top === top && current.height === height ? current : { top, height })
  }, [])

  const refreshTargets = useCallback(() => {
    setTargets(latest.current.resolveTargets())
  }, [])

  /* ── 指针感应 ───────────────────────────────────────── */
  useEffect(() => {
    if (!enabled || touch) {
      hoverSideRef.current = null
      setHoverSide(null)
      setFocusSide(null)
      setDragging(false)
      return
    }

    let raf: number | null = null
    let lastEvent: PointerEvent | null = null
    let pointerOrigin: { x: number; y: number; onNavigation: boolean } | null = null

    const setSide = (next: Side | null, immediate = false) => {
      if (next) {
        if (hideTimer.current) {
          clearTimeout(hideTimer.current)
          hideTimer.current = null
        }
        if (hoverSideRef.current !== next) {
          hoverSideRef.current = next
          refreshTargets()
          placeStrips()
          setHoverSide(next)
        }
        return
      }
      if (immediate) {
        if (hideTimer.current) clearTimeout(hideTimer.current)
        hideTimer.current = null
        hoverSideRef.current = null
        setHoverSide(null)
        return
      }
      if (hoverSideRef.current === null || hideTimer.current) return
      hideTimer.current = setTimeout(() => {
        hideTimer.current = null
        hoverSideRef.current = null
        setHoverSide(null)
      }, HIDE_DELAY)
    }

    const evaluate = () => {
      raf = null
      const e = lastEvent
      if (!e) return
      // 按住鼠标(拖选文字、缩放图片、拖滚动条)期间不做任何导航提示
      if (e.buttons !== 0) return setSide(null, true)
      const width = document.documentElement.clientWidth
      const height = document.documentElement.clientHeight
      if (e.clientX < 0 || e.clientX > width || e.clientY < latest.current.getTopBoundary() || e.clientY >= height) {
        return setSide(null)
      }
      if (e.clientX <= ZONE) return setSide('left')
      if (e.clientX >= width - ZONE) return setSide('right')
      setSide(null)
    }

    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return
      if (e.buttons !== 0 && pointerOrigin && (
        !pointerOrigin.onNavigation ||
        Math.hypot(e.clientX - pointerOrigin.x, e.clientY - pointerOrigin.y) > 6
      )) {
        suppressPointerClick.current = true
        setDragging(true)
      }
      lastEvent = e
      if (raf === null) raf = requestAnimationFrame(evaluate)
    }
    const onLeave = () => setSide(null)
    const onPointerDown = (e: PointerEvent) => {
      const onNavigation = !!navRef.current && e.composedPath().includes(navRef.current)
      pointerOrigin = { x: e.clientX, y: e.clientY, onNavigation }
      suppressPointerClick.current = false
      if (!onNavigation) {
        // 从正文开始的拖选不会被已显现的竖条截住,也不会在松手时翻篇。
        setDragging(true)
        setFocusSide(null)
        setSide(null, true)
      }
    }
    const onPointerUp = () => {
      pointerOrigin = null
      lastEvent = null
      setDragging(false)
    }

    window.addEventListener('pointermove', onMove, { passive: true })
    window.addEventListener('pointerdown', onPointerDown, { passive: true, capture: true })
    window.addEventListener('pointerup', onPointerUp, { passive: true })
    window.addEventListener('pointercancel', onPointerUp, { passive: true })
    document.documentElement.addEventListener('pointerleave', onLeave)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
      document.documentElement.removeEventListener('pointerleave', onLeave)
      if (raf !== null) cancelAnimationFrame(raf)
      if (hideTimer.current) clearTimeout(hideTimer.current)
      hideTimer.current = null
    }
  }, [enabled, touch, placeStrips, refreshTargets])

  const visibleSide = dragging ? null : hoverSide ?? focusSide

  // 选中对象变化(刚翻完一篇)时刷新目标,按钮的无障碍名称因此始终准确
  useEffect(() => {
    if (enabled) {
      refreshTargets()
      placeStrips()
    }
  }, [enabled, selectionKey, visibleSide, refreshTargets, placeStrips])

  useEffect(() => {
    // Touch devices use the fixed bottom buttons. Measuring the desktop edge
    // strip on every vertical scroll only causes React renders there and can
    // compete with the diary's native scroll inertia.
    if (!enabled || touch) return
    let raf: number | null = null
    let settleRaf: number | null = null
    const onGeometryChange = () => {
      if (raf !== null) return
      raf = requestAnimationFrame(() => {
        raf = null
        placeStrips()
        // 父组件也在同一帧更新收缩进度;再测一帧确保停下滚动后边界完全对齐。
        if (settleRaf !== null) cancelAnimationFrame(settleRaf)
        settleRaf = requestAnimationFrame(() => {
          settleRaf = null
          placeStrips()
        })
      })
    }
    const observer = new ResizeObserver(onGeometryChange)
    observer.observe(document.documentElement)
    window.addEventListener('scroll', onGeometryChange, { passive: true })
    window.addEventListener('resize', onGeometryChange, { passive: true })
    return () => {
      observer.disconnect()
      window.removeEventListener('scroll', onGeometryChange)
      window.removeEventListener('resize', onGeometryChange)
      if (raf !== null) cancelAnimationFrame(raf)
      if (settleRaf !== null) cancelAnimationFrame(settleRaf)
    }
  }, [enabled, touch, placeStrips])

  useEffect(
    () => () => {
      if (hintTimer.current) clearTimeout(hintTimer.current)
    },
    [],
  )

  const handleClick = (side: Side) => {
    const fresh = latest.current.resolveTargets()
    const target = side === 'left' ? fresh.prev : fresh.next
    if (!target) {
      // 到达人生两端:轻提示,不循环、不新建
      setHint(side)
      if (hintTimer.current) clearTimeout(hintTimer.current)
      hintTimer.current = setTimeout(() => setHint(null), HINT_DURATION)
      return
    }
    setHint(null)
    onNavigate(target.id)
  }

  if (!enabled) return null

  /* ── 触屏:无悬停可用时,在底部两角给出常驻的小按钮 ── */
  if (touch) {
    return (
      <nav ref={navRef} aria-label="相邻人生记录" className="contents">
        {(['left', 'right'] as const).map((side) => {
          const target = side === 'left' ? targets.prev : targets.next
          return (
            <button
              key={side}
              type="button"
              data-edge-navigation={side}
              onClick={() => handleClick(side)}
              aria-disabled={!target}
              aria-label={target ? `${side === 'left' ? '上一篇' : '下一篇'}:${target.title}` : BOUNDARY_TEXT[side]}
              className={cn(
                'lt-mobile-page-nav fixed z-20 flex size-11 items-center justify-center rounded-full border border-border bg-background/85 backdrop-blur-sm',
                side === 'left' ? 'left-2' : 'right-2',
                target ? 'text-muted-foreground' : 'text-muted-foreground/40',
              )}
              style={{ bottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
            >
              {side === 'left' ? <ChevronLeft className="size-4" /> : <ChevronRight className="size-4" />}
            </button>
          )
        })}
      </nav>
    )
  }

  return (
    <nav ref={navRef} aria-label="相邻人生记录" className="contents">
      {(['left', 'right'] as const).map((side) => {
        const target = side === 'left' ? targets.prev : targets.next
        const visible = visibleSide === side && region.height > 0
        const hinting = hint === side
        const Icon = side === 'left' ? ChevronLeft : ChevronRight
        const verb = side === 'left' ? '上一篇' : '下一篇'
        return (
          <div
            key={side}
            data-edge-navigation-region={side}
            className="pointer-events-none fixed z-20 flex items-center"
            style={{
              top: region.top,
              height: region.height,
              width: STRIP_WIDTH,
              ...(side === 'left' ? { left: 0 } : { right: 0 }),
              flexDirection: side === 'left' ? 'row' : 'row-reverse',
            }}
          >
            <button
              type="button"
              data-edge-navigation={side}
              onClick={(e) => {
                if (e.detail !== 0 && suppressPointerClick.current) return
                handleClick(side)
              }}
              tabIndex={region.height > 0 ? 0 : -1}
              onFocus={(e) => {
                refreshTargets()
                placeStrips()
                if (e.currentTarget.matches(':focus-visible')) setFocusSide(side)
              }}
              onBlur={() => setFocusSide((s) => (s === side ? null : s))}
              aria-disabled={!target}
              aria-label={target ? `${verb}:${target.title},${target.displayDate}` : BOUNDARY_TEXT[side]}
              className={cn(
                'flex h-full w-full shrink-0 items-center justify-center overflow-hidden border-border bg-muted/65 backdrop-blur-sm transition-opacity duration-200 ease-out focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:outline-none motion-reduce:transition-none',
                side === 'left' ? 'border-r' : 'border-l',
                visible ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0',
                target
                  ? 'cursor-pointer text-muted-foreground hover:border-foreground/30 hover:bg-muted/90 hover:text-foreground'
                  : 'cursor-default text-muted-foreground/40',
              )}
            >
              <Icon className="size-4 shrink-0" />
            </button>

            {/* 目标记录 / 边界提示:只作说明,不接收指针 */}
            <span
              aria-hidden="true"
              className={cn(
                'mx-2.5 flex max-h-full max-w-56 shrink-0 flex-col overflow-hidden rounded-md border border-border bg-popover px-2.5 py-1.5 text-popover-foreground shadow-sm transition-opacity duration-200 motion-reduce:transition-none',
                visible && region.height >= 48 ? 'opacity-100' : 'opacity-0',
                side === 'left' ? 'items-start' : 'items-end',
              )}
            >
              {hinting || !target ? (
                <span className="text-xs leading-relaxed text-muted-foreground">{BOUNDARY_TEXT[side]}</span>
              ) : (
                <>
                  <span className="text-[11px] leading-relaxed text-muted-foreground">
                    {verb} · <span className="font-mono tabular-nums">{formatCompactDate(target)}</span>
                  </span>
                  <span className="max-w-full truncate text-xs leading-relaxed">{target.title}</span>
                </>
              )}
            </span>
          </div>
        )
      })}
    </nav>
  )
}
