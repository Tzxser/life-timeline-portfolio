import { isDesktopRuntime } from './platform'
import { isAndroidRuntime } from './platform/runtime'

/** WebView2 can keep document.hasFocus() true in a minimized native window.
 * On Windows the native window is authoritative; Android/browser use the real
 * document lifecycle. All subscribers receive the same combined rule. */
export function observeAppForeground(changed: (foreground: boolean) => void): () => void {
  let disposed = false
  let nativeReady = false
  let nativeFocused = false
  let unlisten: (() => void) | undefined
  let last: boolean | null = null
  const notify = () => {
    if (disposed) return
    const foreground = document.visibilityState === 'visible' && (nativeReady ? nativeFocused : document.hasFocus())
    if (foreground !== last) { last = foreground; changed(foreground) }
  }
  window.addEventListener('focus', notify)
  window.addEventListener('blur', notify)
  document.addEventListener('visibilitychange', notify)
  notify()
  if (isDesktopRuntime() && !isAndroidRuntime()) {
    void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
      const window = getCurrentWindow()
      const dispose = await window.onFocusChanged(({ payload }) => {
        nativeReady = true
        nativeFocused = payload
        notify()
      })
      if (disposed) { dispose(); return }
      unlisten = dispose
      nativeFocused = await window.isFocused()
      nativeReady = true
      notify()
    }).catch(() => { /* DOM lifecycle still works if the native listener fails. */ })
  }
  return () => {
    disposed = true
    unlisten?.()
    window.removeEventListener('focus', notify)
    window.removeEventListener('blur', notify)
    document.removeEventListener('visibilitychange', notify)
  }
}
