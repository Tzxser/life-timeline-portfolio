'use client'

import { useEffect, useState } from 'react'
import { exit, onBackButtonPress } from '@tauri-apps/api/app'
import { useLifeStore } from '@/lib/life-store'
import { dismissActiveOverlay } from '@/lib/overlay-registry'
import { isAndroidRuntime } from '@/lib/platform/runtime'

/** Mobile-only lifecycle and viewport behavior; never changes stored content. */
export function MobileRuntime() {
  const { flushPersistence } = useLifeStore()
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    const root = document.documentElement
    const touch = window.matchMedia('(hover: none) and (pointer: coarse)')
    const viewport = window.visualViewport
    let width = window.innerWidth
    let fullHeight = Math.max(window.innerHeight, viewport?.height ?? 0)
    const update = () => {
      const height = viewport?.height ?? window.innerHeight
      if (Math.abs(window.innerWidth - width) > 80) {
        width = window.innerWidth
        fullHeight = Math.max(window.innerHeight, height)
      } else {
        fullHeight = Math.max(fullHeight, window.innerHeight, height)
      }
      const editing = Boolean(document.activeElement?.closest('input:not([type="checkbox"]):not([type="radio"]), textarea, [contenteditable="true"]'))
      root.toggleAttribute('data-mobile-keyboard-open', touch.matches && editing && fullHeight - height > 140)
      root.style.setProperty('--lt-visible-height', `${height}px`)
    }
    update()
    window.addEventListener('resize', update, { passive: true })
    viewport?.addEventListener('resize', update, { passive: true })
    document.addEventListener('focusin', update)
    document.addEventListener('focusout', update)
    return () => {
      window.removeEventListener('resize', update)
      viewport?.removeEventListener('resize', update)
      document.removeEventListener('focusin', update)
      document.removeEventListener('focusout', update)
      root.removeAttribute('data-mobile-keyboard-open')
      root.style.removeProperty('--lt-visible-height')
    }
  }, [])

  useEffect(() => {
    if (!isAndroidRuntime()) return
    let active = true
    let working = false
    let lastBack = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    let remove: (() => Promise<void>) | undefined
    const tell = (message: string, duration = 2600) => {
      if (!active) return
      setNotice(message)
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { if (active) setNotice(null) }, duration)
    }
    void onBackButtonPress(() => {
      if (working) return
      if (dismissActiveOverlay()) { lastBack = 0; return }
      const focused = document.activeElement
      if (focused instanceof HTMLElement && focused.closest('input, textarea, [contenteditable="true"]')) {
        focused.blur()
        lastBack = 0
        return
      }
      const shouldExit = Date.now() - lastBack < 2400
      lastBack = Date.now()
      working = true
      void flushPersistence().then(async () => {
        if (!active) return
        if (shouldExit) await exit(0)
        else tell('已保存，再按一次返回退出')
      }).catch(() => tell('尚未完成保存，已保留当前页面。请在设置中重试保存。', 6000))
        .finally(() => { working = false })
    }).then((listener) => {
      if (!active) void listener.unregister()
      else remove = () => listener.unregister()
    }).catch(() => tell('系统返回键暂不可用，请使用页面内的返回按钮。', 6000))
    return () => {
      active = false
      if (timer) clearTimeout(timer)
      void remove?.()
    }
  }, [flushPersistence])

  if (!notice) return null
  return <p role="status" aria-live="polite" className="lt-mobile-notice pointer-events-none fixed inset-x-6 bottom-20 z-[90] mx-auto max-w-sm rounded-lg border border-border bg-background/95 px-4 py-3 text-center text-sm text-foreground shadow-lg">{notice}</p>
}
