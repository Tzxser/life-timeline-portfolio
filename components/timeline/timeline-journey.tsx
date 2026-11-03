'use client'

import { useEffect, useRef, type RefObject } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { SeasonalMonth } from '@/lib/seasonal-timeline'

interface Props {
  scrollRef: RefObject<HTMLDivElement | null>
  totalWidth: number
  viewportWidth: number
  months: SeasonalMonth[]
  disabled: boolean
}

/** One frame updates only this thumb; scrolling does not rebuild timeline geometry. */
export function TimelineJourney({ scrollRef, totalWidth, viewportWidth, months, disabled }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const thumbRef = useRef<HTMLSpanElement>(null)
  const earlierRef = useRef<HTMLButtonElement>(null)
  const laterRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let frame = 0
    const update = () => {
      frame = 0
      const max = Math.max(0, el.scrollWidth - el.clientWidth)
      const ratio = max ? el.scrollLeft / max : 0
      const width = Math.min(100, el.clientWidth / totalWidth * 100)
      if (inputRef.current) inputRef.current.value = String(Math.round(ratio * 1000))
      if (thumbRef.current) {
        thumbRef.current.style.width = `${width}%`
        thumbRef.current.style.left = `${ratio * (100 - width)}%`
      }
      if (earlierRef.current) earlierRef.current.disabled = disabled || el.scrollLeft <= 1
      if (laterRef.current) laterRef.current.disabled = disabled || el.scrollLeft >= max - 1
    }
    const queue = () => { if (!frame) frame = requestAnimationFrame(update) }
    update()
    el.addEventListener('scroll', queue, { passive: true })
    return () => { el.removeEventListener('scroll', queue); cancelAnimationFrame(frame) }
  }, [scrollRef, totalWidth, viewportWidth, disabled])
  const pan = (direction: number) => {
    const el = scrollRef.current
    if (el) el.scrollBy({ left: el.clientWidth * .65 * direction, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }
  const stops = months.map(month => `var(--${month.season}-wash) ${(month.x + month.width / 2) / totalWidth * 100}%`)
  return (
    <div className="lt-timeline-journey" role="group" aria-label="时间轴浏览位置">
      <button type="button" ref={earlierRef} onClick={() => pan(-1)} disabled={disabled} aria-label="往前浏览时间轴"><ChevronLeft aria-hidden="true" /></button>
      <div className="lt-journey-track-wrap">
        <div className="lt-journey-track" style={{ background: `linear-gradient(90deg, ${stops.join(', ')})` }} aria-hidden="true"><span ref={thumbRef} className="lt-journey-window" /></div>
        <input ref={inputRef} type="range" min={0} max={1000} defaultValue={0} disabled={disabled} aria-label="时间轴位置" onChange={event => { const el = scrollRef.current; if (el) el.scrollLeft = (el.scrollWidth - el.clientWidth) * Number(event.target.value) / 1000 }} />
        <div className="lt-journey-years" aria-hidden="true"><span>{months[0]?.year}</span><span>{months.at(-1)?.year}</span></div>
      </div>
      <button type="button" ref={laterRef} onClick={() => pan(1)} disabled={disabled} aria-label="往后浏览时间轴"><ChevronRight aria-hidden="true" /></button>
    </div>
  )
}
