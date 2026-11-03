'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { isDesktopRuntime } from '@/lib/platform'
import { loadDesktopPreferences, saveDesktopPreferences } from '@/lib/preferences'

const STORAGE_KEY = 'life-timeline.show-seasonal-splash'
const DEFAULT_SHOW_SEASONAL_SPLASH = true

interface StartupPreferencesValue {
  showSeasonalSplash: boolean
  setShowSeasonalSplash: (show: boolean) => void
}

const StartupPreferencesContext = createContext<StartupPreferencesValue | null>(null)

function readBrowserPreference(): boolean {
  if (typeof window === 'undefined') return DEFAULT_SHOW_SEASONAL_SPLASH
  try {
    const value = window.localStorage.getItem(STORAGE_KEY)
    return value === null ? DEFAULT_SHOW_SEASONAL_SPLASH : value !== 'false'
  } catch {
    return DEFAULT_SHOW_SEASONAL_SPLASH
  }
}

function writeBrowserPreference(value: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(value))
  } catch {
    // A restricted browser profile should not make the rest of the app fail.
  }
}

export function StartupPreferencesProvider({ children }: { children: ReactNode }) {
  // The first client render must match the static HTML. Reading storage in
  // the initializer can omit a server-rendered splash before hydration owns
  // it, leaving that opening layer stranded above an otherwise ready app.
  const [showSeasonalSplash, setShowSeasonalSplashState] = useState(DEFAULT_SHOW_SEASONAL_SPLASH)

  useEffect(() => {
    let cancelled = false
    setShowSeasonalSplashState(readBrowserPreference())
    void loadDesktopPreferences()
      .then((preferences) => {
        if (cancelled || !preferences || typeof preferences.showSeasonalSplash !== 'boolean') return
        setShowSeasonalSplashState(preferences.showSeasonalSplash)
        writeBrowserPreference(preferences.showSeasonalSplash)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  const setShowSeasonalSplash = useCallback((show: boolean) => {
    setShowSeasonalSplashState(show)
    writeBrowserPreference(show)
    if (isDesktopRuntime()) void saveDesktopPreferences({ showSeasonalSplash: show }).catch(() => undefined)
  }, [])

  const value = useMemo(() => ({ showSeasonalSplash, setShowSeasonalSplash }), [showSeasonalSplash, setShowSeasonalSplash])
  return <StartupPreferencesContext.Provider value={value}>{children}</StartupPreferencesContext.Provider>
}

export function useStartupPreferences(): StartupPreferencesValue {
  const context = useContext(StartupPreferencesContext)
  if (!context) throw new Error('useStartupPreferences 必须在 StartupPreferencesProvider 内使用')
  return context
}
