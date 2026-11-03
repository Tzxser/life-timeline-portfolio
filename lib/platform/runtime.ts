/** Keep the existing native data contract shared by desktop and Android. */
export function isAndroidRuntime(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false
  const nativeWindow = window as Window & { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown }
  return Boolean(nativeWindow.__TAURI_INTERNALS__ || nativeWindow.__TAURI__)
    && /\bAndroid\b/i.test(navigator.userAgent)
}
