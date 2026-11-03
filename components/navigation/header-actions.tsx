'use client'

import { useRef, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { HeaderButton, HeaderCollapseIcon } from '@/components/common/header-icons'

type HeaderActionsProps = {
  collapsed: boolean
  onToggle: (collapsed?: boolean) => void
  children: ReactNode
}

/**
 * 顶部六个功能的可收纳停靠栏。
 *
 * The buttons stay mounted while the dock animates out, so the transition is
 * graceful and each existing action keeps its own state. `inert` makes the
 * visually hidden actions unavailable to keyboard and assistive technology.
 */
export function HeaderActions({ collapsed, onToggle, children }: HeaderActionsProps) {
  const gestureRef = useRef<{ pointerId: number; edge: 'start' | 'end'; x: number; captured: boolean } | null>(null)
  const suppressClickRef = useRef(false)
  const suppressClickTimerRef = useRef<number | null>(null)

  const clearClickSuppression = () => {
    if (suppressClickTimerRef.current !== null) {
      window.clearTimeout(suppressClickTimerRef.current)
      suppressClickTimerRef.current = null
    }
    suppressClickRef.current = false
  }

  const scheduleClickSuppressionClear = () => {
    if (suppressClickTimerRef.current !== null) window.clearTimeout(suppressClickTimerRef.current)
    // Keep the swipe's synthetic click blocked through the 680ms collapse
    // transition, then release the guard even if the browser emits no click.
    suppressClickTimerRef.current = window.setTimeout(() => {
      suppressClickTimerRef.current = null
      suppressClickRef.current = false
    }, 800)
  }

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (collapsed || event.pointerType === 'mouse' && event.button !== 0) return
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-collapse-edge]') : null
    const edge = target?.dataset.collapseEdge
    if (edge !== 'start' && edge !== 'end') return
    // Do not capture on pointerdown. Capturing the parent immediately makes a
    // normal click on the first/last button retarget its click event to the
    // shell, so the child action never receives onClick. Capture only after
    // the pointer has clearly started a horizontal gesture below.
    gestureRef.current = { pointerId: event.pointerId, edge, x: event.clientX, captured: false }
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    const distance = event.clientX - gesture.x
    const crossed = gesture.edge === 'start' ? distance >= 44 : distance <= -44
    if (!crossed) return
    // Capture only after the 44px swipe threshold. A regular tap never gives
    // the shell pointer capture, so the edge button keeps its own click.
    if (!gesture.captured) {
      event.currentTarget.setPointerCapture?.(event.pointerId)
      gesture.captured = true
    }
    event.preventDefault()
    suppressClickRef.current = true
    scheduleClickSuppressionClear()
    gestureRef.current = null
    onToggle(true)
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  const clearGesture = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current
    if (gesture?.pointerId !== event.pointerId) return
    if (gesture.captured && event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId)
    }
    gestureRef.current = null
  }

  const handleClickCapture = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!suppressClickRef.current) return
    event.preventDefault()
    event.stopPropagation()
    clearClickSuppression()
  }

  const items = Array.isArray(children) ? children : [children]

  return (
    <div
      className="lt-header-actions lt-header-action-shell flex items-center gap-1"
      data-collapsed={collapsed ? 'true' : 'false'}
      aria-label="顶部功能"
      aria-hidden={collapsed}
      inert={collapsed}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={clearGesture}
      onPointerCancel={clearGesture}
      onClickCapture={handleClickCapture}
    >
      {items.map((item, index) => (
        <div
          // Children are the six existing actions in their original order.
          key={index}
          className="lt-header-action-slot flex shrink-0 items-center"
          style={{
            // The staggered values keep the six controls moving as one small
            // gesture instead of making the whole row blink away at once.
            '--lt-header-action-expand-delay': `${index * 42}ms`,
            '--lt-header-action-collapse-delay': `${(items.length - index - 1) * 48}ms`,
            '--lt-header-action-shift': `${(index - items.length + 1) * 9}px`,
          } as CSSProperties}
          data-collapse-edge={index === 0 ? 'start' : index === items.length - 1 ? 'end' : undefined}
        >
          {item}
        </div>
      ))}
    </div>
  )
}

export function HeaderActionsToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  return (
    <HeaderButton
      className="lt-header-collapse-toggle size-7"
      onClick={onToggle}
      data-state={collapsed ? 'closed' : 'open'}
      aria-label={collapsed ? '展开顶部功能' : '收纳顶部功能'}
      aria-pressed={collapsed}
      title={collapsed ? '展开顶部功能' : '收纳顶部功能'}
    >
      <HeaderCollapseIcon collapsed={collapsed} />
    </HeaderButton>
  )
}
