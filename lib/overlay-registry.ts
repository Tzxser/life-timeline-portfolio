'use client'

// 全局遮罩登记:抽屉、搜索、大图预览打开时登记一次。
// 底层的边缘翻篇与回到顶部据此整体暂停,不会透过遮罩被误触。

import { useSyncExternalStore } from 'react'

let openCount = 0
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

/** 登记一个已打开的遮罩,返回释放函数(重复调用安全) */
export function registerOverlay(): () => void {
  openCount += 1
  emit()
  let released = false
  return () => {
    if (released) return
    released = true
    openCount -= 1
    emit()
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useAnyOverlayOpen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => openCount > 0,
    () => false,
  )
}

/** Android Back follows the same close/confirmation paths as Escape. */
export function dismissActiveOverlay(): boolean {
  const themeNotice = document.querySelector('[data-theme-notice]')
  if (themeNotice) {
    themeNotice.dispatchEvent(new Event('cancel'))
    return true
  }
  const dialogs = document.querySelectorAll<HTMLDialogElement>('dialog[open]')
  const dialog = dialogs.item(dialogs.length - 1)
  if (dialog) {
    // Dispatch cancel rather than close(): a busy import or an unconfirmed
    // date change must retain its existing veto/confirmation behavior.
    dialog.dispatchEvent(new Event('cancel', { cancelable: true }))
    return true
  }
  const hadOverlay = openCount > 0
  const event = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })
  ;(document.activeElement ?? document).dispatchEvent(event)
  return hadOverlay || event.defaultPrevented
}

/**
 * 当前主要输入是否为触屏(无悬停 + 粗指针)。用于提供不依赖 hover 的替代入口。
 * 只看 hover: none 会把“没有任何指针信息”的环境也误判成触屏。
 */
const TOUCH_QUERY = '(hover: none) and (pointer: coarse)'

function subscribeHover(listener: () => void) {
  const mql = window.matchMedia(TOUCH_QUERY)
  mql.addEventListener('change', listener)
  return () => mql.removeEventListener('change', listener)
}

export function useNoHover(): boolean {
  return useSyncExternalStore(
    subscribeHover,
    () => window.matchMedia(TOUCH_QUERY).matches,
    () => false,
  )
}
