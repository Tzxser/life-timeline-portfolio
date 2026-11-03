import { isDesktopRuntime } from './platform'

export type Preferences = Record<string, unknown>

/**
 * Desktop preference writes share the life-store snapshot queue once the
 * native repository has been opened.  Keeping this bridge here avoids having
 * ThemeProvider and TimelineSettingsProvider issue independent SQLite writes
 * that can race an event save.  During the very short bootstrap window, the
 * command fallback is still used so loading preferences never depends on
 * React provider ordering.
 */
export interface DesktopPreferencePersistence {
  save: (patch: Preferences) => Promise<void>
}

let persistenceBridge: DesktopPreferencePersistence | null = null
const errorListeners = new Set<(error: unknown) => void>()

export function registerDesktopPreferencePersistence(
  bridge: DesktopPreferencePersistence | null,
): () => void {
  persistenceBridge = bridge
  return () => {
    if (persistenceBridge === bridge) persistenceBridge = null
  }
}

export function subscribeDesktopPreferenceErrors(listener: (error: unknown) => void): () => void {
  errorListeners.add(listener)
  return () => errorListeners.delete(listener)
}

function reportPreferenceError(error: unknown): void {
  // Keep a concrete diagnostic even before the store's status listener has
  // mounted; callers still receive the rejection and may render their own UI.
  console.error('[life-timeline] 本地偏好设置保存失败', error)
  for (const listener of errorListeners) listener(error)
}

async function invoke(command: string, args?: Record<string, unknown>): Promise<unknown> {
  const core = await import('@tauri-apps/api/core')
  if (typeof core.invoke !== 'function') throw new Error('桌面通信模块不可用')
  return core.invoke(command, args)
}

export async function loadDesktopPreferences(): Promise<Preferences | null> {
  if (!isDesktopRuntime()) return null
  try {
    const value = await invoke('load_preferences')
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Preferences : {}
  } catch (error) {
    reportPreferenceError(error)
    throw error
  }
}

export async function saveDesktopPreferences(preferences: Preferences): Promise<void> {
  if (!isDesktopRuntime()) return
  try {
    if (persistenceBridge) {
      await persistenceBridge.save(preferences)
      return
    }
    await invoke('save_preferences', { preferences })
  } catch (error) {
    reportPreferenceError(error)
    throw error
  }
}
