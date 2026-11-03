'use client'

// 底部回到顶部:页面已向下滚动时,鼠标靠近应用视口底边,底部中央浮出向上按钮。
// 靠近只显示,点击才滚动;只把纵向位置送回 0 ——
// 时间轴由既有的 --tl-p 机制自然展开,横向位置、缩放、选中记录与正文一概不动。

import { useEffect, useRef, useState } from 'react'
import { ArrowUp } from 'lucide-react'
import { useNoHover } from '@/lib/overlay-registry'
import { cn } from '@/lib/utils'

const AVAILABLE_AFTER = 120 // 滚动超过这个距离才提供回顶
const BAND = 64 // 底部感应带高度
const SIDE_RESERVED = 64 // 左右两角留给翻篇导航
const HIDE_DELAY = 200

export function BackToTop({ enabled }: { enabled: boolean }) {
  const touch = useNoHover()
  const [available, setAvailable] = useState(false)
  const [near, setNear] = useState(false)
  const [focused, setFocused] = useState(false)
  const nearRef = useRef(false)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let raf: number | null = null
    const check = () => {
      raf = null
      setAvailable(window.scrollY > AVAILABLE_AFTER)
    }
    const onScroll = () => {
      if (raf === null) raf = requestAnimationFrame(check)
    }
    check()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      if (raf !== null) cancelAnimationFrame(raf)
    }
  }, [])

  useEffect(() => {
    if (!enabled || touch || !available) {
      nearRef.current = false
      setNear(false)
      return
    }
    let raf: number | null = null
    let lastEvent: PointerEvent | null = null

    const setInBand = (inBand: boolean) => {
      if (inBand) {
        if (hideTimer.current) {
          clearTimeout(hideTimer.current)
          hideTimer.current = null
        }
        if (!nearRef.current) {
          nearRef.current = true
          setNear(true)
        }
        return
      }
      if (!nearRef.current || hideTimer.current) return
      hideTimer.current = setTimeout(() => {
        hideTimer.current = null
        nearRef.current = false
        setNear(false)
      }, HIDE_DELAY)
    }

    const evaluate = () => {
      raf = null
      const e = lastEvent
      if (!e) return
      const width = document.documentElement.clientWidth
      setInBand(
        e.buttons === 0 &&
          e.clientY >= window.innerHeight - BAND &&
          e.clientX > SIDE_RESERVED &&
          e.clientX < width - SIDE_RESERVED,
      )
    }
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return
      lastEvent = e
      if (raf === null) raf = requestAnimationFrame(evaluate)
    }
    const onLeave = () => setInBand(false)

    window.addEventListener('pointermove', onMove, { passive: true })
    document.documentElement.addEventListener('pointerleave', onLeave)
    return () => {
      window.removeEventListener('pointermove', onMove)
      document.documentElement.removeEventListener('pointerleave', onLeave)
      if (raf !== null) cancelAnimationFrame(raf)
      if (hideTimer.current) clearTimeout(hideTimer.current)
      hideTimer.current = null
    }
  }, [enabled, touch, available])

  // 已在顶部、没有滚动空间或有遮罩时,不提供一个没有意义的按钮
  if (!enabled || !available) return null

  const visible = touch || near || focused

  const scrollToTop = () => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    // 交给浏览器原生平滑滚动:用户滚轮 / 触摸可随时接管,重复点击也不会叠加动画
    window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' })
  }

  return (
    <button
      type="button"
      onClick={scrollToTop}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      aria-label="回到页面顶部"
      title="回到顶部"
      className={cn(
        'fixed left-1/2 z-20 flex size-11 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-background/80 text-muted-foreground backdrop-blur-sm transition-opacity duration-200 ease-out hover:border-foreground/30 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
        visible ? 'opacity-100' : 'pointer-events-none opacity-0',
        touch ? 'lt-mobile-page-nav opacity-90' : '',
      )}
      style={{ bottom: 'max(1rem, env(safe-area-inset-bottom))' }}
    >
      <ArrowUp className="size-4" />
    </button>
  )
}
