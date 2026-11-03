/**
 * Tracks a renderer that is being torn down.
 *
 * Tauri's mobile IPC replies are delivered through callbacks owned by the
 * current WebView document.  Starting another asynchronous command from a
 * beforeunload/pagehide handler races document teardown; the native bridge can
 * then report that its callback no longer exists.  Keep this marker on the
 * Window so all platform adapters can make the same decision without sharing
 * React state.
 */
const UNLOADING_KEY = '__LIFE_TIMELINE_PAGE_UNLOADING__'

interface LifecycleWindow extends Window {
  [UNLOADING_KEY]?: boolean
}

export function markPageUnloading(): void {
  if (typeof window === 'undefined') return
  ;(window as LifecycleWindow)[UNLOADING_KEY] = true
}

export function isPageUnloading(): boolean {
  if (typeof window === 'undefined') return false
  return Boolean((window as LifecycleWindow)[UNLOADING_KEY])
}
