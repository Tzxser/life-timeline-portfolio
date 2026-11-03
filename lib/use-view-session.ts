'use client'

import { useEffect, useLayoutEffect, useRef } from 'react'
import { todayKey } from '@/types/life-event'
import { saveDesktopPreferences } from './preferences'
import { registerBeforePersistenceFlush } from './persistence/flush-barrier'
import { isPageUnloading } from './page-lifecycle'
import { observeAppForeground } from './app-foreground'
import { VIEW_SESSION_KEY, type ViewSession } from './view-session'

/** Debounced checkpoints share the diary save queue; close/background drains
 * them too. No diary text, selection range, dialog or keyboard is cached here. */
export function useViewSession(options: {
  ready: boolean
  desktop: boolean
  capture: () => Omit<ViewSession, 'version' | 'localDate'>
  flush: () => Promise<void>
  openToday: () => void
}) {
  const optionsRef = useRef(options)
  useLayoutEffect(() => { optionsRef.current = options })
  const lastActiveDate = useRef(todayKey())
  const previous = useRef('')
  const pending = useRef<Promise<void> | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const resumeInProgress = useRef(false)

  useEffect(() => {
    if (!options.ready) return
    let alive = true
    const capture = (): ViewSession => ({ version: 1, localDate: lastActiveDate.current, ...optionsRef.current.capture() })
    const save = async () => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
      // Serialize two checkpoints (e.g. timer and close); never let an older
      // scroll position arrive after the most recent one.
      if (pending.current) await pending.current
      const session = capture()
      const serialized = JSON.stringify(session)
      if (serialized === previous.current) return
      if (optionsRef.current.desktop) {
        const write = saveDesktopPreferences({ viewSession: session })
        pending.current = write
        try { await write } finally { if (pending.current === write) pending.current = null }
      } else {
        try { localStorage.setItem(VIEW_SESSION_KEY, serialized) } catch { /* Preview-only cache. */ }
      }
      previous.current = serialized
    }
    const checkpoint = () => {
      if (timer.current) return
      timer.current = setTimeout(() => { void save().catch(() => { /* Store exposes save errors. */ }) }, 350)
    }
    const interacted = () => {
      if (document.visibilityState === 'visible' && !resumeInProgress.current) lastActiveDate.current = todayKey()
      checkpoint()
    }
    const resume = () => {
      if (document.visibilityState !== 'visible' || lastActiveDate.current === todayKey() || resumeInProgress.current) return
      resumeInProgress.current = true
      // Wait for IME/editor work before changing documents. An error keeps the
      // old diary on screen so the existing save-protection UI can recover it.
      void optionsRef.current.flush().then(() => {
        if (!alive || document.visibilityState !== 'visible') return
        lastActiveDate.current = todayKey()
        optionsRef.current.openToday()
      }).catch(() => undefined).finally(() => { resumeInProgress.current = false })
    }
    const visibility = () => {
      if (isPageUnloading()) return
      if (document.visibilityState === 'hidden') void save().catch(() => undefined)
      else resume()
    }
    const dispose = registerBeforePersistenceFlush(save)
    // Scroll does not bubble, so capture also covers the horizontal timeline.
    document.addEventListener('scroll', interacted, { passive: true, capture: true })
    document.addEventListener('pointerdown', interacted, { passive: true })
    document.addEventListener('input', interacted)
    document.addEventListener('keydown', interacted)
    document.addEventListener('visibilitychange', visibility)
    const stopForeground = observeAppForeground((foreground) => {
      if (foreground) resume()
      else if (!isPageUnloading()) void save().catch(() => undefined)
    })
    const pagehide = () => {
      // Native exit was already awaited through the barrier. Browser preview
      // reloads still get a synchronous checkpoint without new teardown IPC.
      if (!optionsRef.current.desktop) {
        try { localStorage.setItem(VIEW_SESSION_KEY, JSON.stringify(capture())) } catch { /* Best effort. */ }
      }
    }
    window.addEventListener('pagehide', pagehide)
    checkpoint()
    return () => {
      alive = false
      dispose()
      if (timer.current) clearTimeout(timer.current)
      document.removeEventListener('scroll', interacted, true)
      document.removeEventListener('pointerdown', interacted)
      document.removeEventListener('input', interacted)
      document.removeEventListener('keydown', interacted)
      document.removeEventListener('visibilitychange', visibility)
      stopForeground()
      window.removeEventListener('pagehide', pagehide)
    }
  }, [options.ready])
}
