'use client'

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { isDesktopRuntime } from './platform'
import { loadDesktopPreferences, saveDesktopPreferences, type Preferences } from './preferences'
import { registerBeforePersistenceFlush } from './persistence/flush-barrier'
import { observeAppForeground } from './app-foreground'
import {
  DEFAULT_THEME_AUTOMATION_SETTINGS, EYECARE_REMINDERS, migrateThemeAutomation,
  nextReminderIndex, nextThemePrompt, normalizeThemeAutomationSettings, scheduleTriggerKey,
  type AutomaticThemePrompt, type ThemeAutomationSettings,
} from './theme-automation'

export type Theme = 'light' | 'dark' | 'eyecare'
export const THEME_ORDER: Theme[] = ['light', 'dark', 'eyecare']
export const THEME_LABEL: Record<Theme, string> = { light: '亮色模式', dark: '暗色模式', eyecare: '护眼模式' }
export const THEME_STORAGE_KEY = 'life-timeline-theme'
const AUTOMATION_STORAGE_KEY = 'life-timeline-theme-automation'
const STATE_STORAGE_KEY = 'life-timeline-theme-automation-state'
const RULES_STORAGE_KEY = 'life-timeline-theme-rules-version'

interface ThemeContextValue {
  theme: Theme
  cycleTheme: () => void
  setTheme: (theme: Theme) => void
  automation: ThemeAutomationSettings
  setAutomation: (patch: Partial<ThemeAutomationSettings>) => void
  prompt: (AutomaticThemePrompt & { reminder: string }) | null
  respondToPrompt: (choice: 'accept' | 'cancel' | 'disable') => void
  disabledNotice: boolean
  dismissDisabledNotice: () => void
}
const ThemeContext = createContext<ThemeContextValue | null>(null)

function applyTheme(theme: Theme) {
  document.documentElement.classList.remove('light', 'dark', 'eyecare')
  document.documentElement.classList.add(theme)
}
function writeCache(key: string, value: string) {
  try { localStorage.setItem(key, value) } catch { /* Native preferences remain authoritative. */ }
}
function readCache(key: string): unknown {
  try { return JSON.parse(localStorage.getItem(key) ?? 'null') } catch { return null }
}
function isTheme(value: unknown): value is Theme { return THEME_ORDER.includes(value as Theme) }
function automationState(value: unknown) {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return {
    handledSchedule: typeof raw.handledSchedule === 'string' ? raw.handledSchedule : null,
    lastReminderIndex: typeof raw.lastReminderIndex === 'number' ? raw.lastReminderIndex : -1,
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>('light')
  const [automation, setAutomationState] = useState(DEFAULT_THEME_AUTOMATION_SETTINGS)
  const [ready, setReady] = useState(false)
  const [prompt, setPrompt] = useState<ThemeContextValue['prompt']>(null)
  const [disabledNotice, setDisabledNotice] = useState(false)
  const themeRef = useRef<Theme>('light')
  const baseThemeRef = useRef<Theme>('light')
  const automationRef = useRef(DEFAULT_THEME_AUTOMATION_SETTINGS)
  const decisionRef = useRef(automationState(null))
  const temporaryEyeCare = useRef(false)
  const eyeCareHandled = useRef(false)
  const activity = useRef<{ startedAt: number | null; accumulatedMs: number }>({ startedAt: null, accumulatedMs: 0 })
  const foregroundRef = useRef(false)
  const promptRef = useRef<ThemeContextValue['prompt']>(null)
  const pendingWrites = useRef(new Set<Promise<void>>())
  const failedPatch = useRef<Preferences | null>(null)

  const display = useCallback((next: Theme) => {
    themeRef.current = next
    setThemeState(next)
    applyTheme(next)
  }, [])
  const clearPrompt = useCallback(() => { promptRef.current = null; setPrompt(null) }, [])
  const persist = useCallback(() => {
    // Temporary eye care never replaces the durable theme or the prepaint cache.
    const patch = {
      theme: baseThemeRef.current,
      themeAutomation: automationRef.current,
      themeAutomationState: { ...decisionRef.current },
      themeAutomationRulesVersion: 2,
    }
    writeCache(THEME_STORAGE_KEY, patch.theme)
    writeCache(AUTOMATION_STORAGE_KEY, JSON.stringify(patch.themeAutomation))
    writeCache(STATE_STORAGE_KEY, JSON.stringify(patch.themeAutomationState))
    writeCache(RULES_STORAGE_KEY, '2')
    if (!isDesktopRuntime()) return
    const write = saveDesktopPreferences(patch)
    pendingWrites.current.add(write)
    void write.then(() => { failedPatch.current = null }, () => { failedPatch.current = patch })
      .finally(() => pendingWrites.current.delete(write))
  }, [])

  useEffect(() => registerBeforePersistenceFlush(async () => {
    await Promise.all([...pendingWrites.current])
    if (failedPatch.current) {
      await saveDesktopPreferences(failedPatch.current)
      failedPatch.current = null
    }
  }), [])

  useEffect(() => {
    let alive = true
    const load = async () => {
      const fromScript = THEME_ORDER.find((value) => document.documentElement.classList.contains(value)) ?? 'light'
      let preferences: Preferences | null = null
      if (isDesktopRuntime()) {
        try { preferences = await loadDesktopPreferences() }
        catch { /* Loading errors are reported by the preference service. */ }
      }
      if (!alive) return
      const base = isTheme(preferences?.theme) ? preferences.theme : fromScript
      const settings = migrateThemeAutomation(preferences ? preferences.themeAutomation : readCache(AUTOMATION_STORAGE_KEY),
        preferences ? preferences.themeAutomationRulesVersion : readCache(RULES_STORAGE_KEY))
      const decision = automationState(preferences ? preferences.themeAutomationState : readCache(STATE_STORAGE_KEY))
      // First migration honors the user's last color immediately. Only a later
      // boundary (or explicitly enabling/changing the rule) starts a prompt.
      decision.handledSchedule ??= scheduleTriggerKey(new Date(), settings)
      baseThemeRef.current = base
      automationRef.current = settings
      decisionRef.current = decision
      display(base)
      setAutomationState(settings)
      writeCache(THEME_STORAGE_KEY, base)
      writeCache(AUTOMATION_STORAGE_KEY, JSON.stringify(settings))
      writeCache(STATE_STORAGE_KEY, JSON.stringify(decision))
      writeCache(RULES_STORAGE_KEY, '2')
      // Bootstrap write completes before the library creates its snapshot queue.
      if (preferences) {
        try { await saveDesktopPreferences({ theme: base, themeAutomation: settings, themeAutomationState: decision, themeAutomationRulesVersion: 2 }) }
        catch { /* Loading errors were already reported by the service. */ }
      }
      if (alive) setReady(true)
    }
    void load()
    return () => { alive = false }
  }, [display])

  const setTheme = useCallback((next: Theme) => {
    temporaryEyeCare.current = false
    baseThemeRef.current = next
    decisionRef.current.handledSchedule = scheduleTriggerKey(new Date(), automationRef.current)
    clearPrompt()
    display(next)
    persist()
  }, [clearPrompt, display, persist])

  const setAutomation = useCallback((patch: Partial<ThemeAutomationSettings>) => {
    const previous = automationRef.current
    const next = normalizeThemeAutomationSettings({ ...previous, ...patch })
    if (next.enabled !== previous.enabled || next.scheduleEnabled !== previous.scheduleEnabled || next.dayStartMinutes !== previous.dayStartMinutes || next.nightStartMinutes !== previous.nightStartMinutes) {
      decisionRef.current.handledSchedule = null
    }
    if (next.eyeCareEnabled !== previous.eyeCareEnabled || next.eyeCareAfterMinutes !== previous.eyeCareAfterMinutes || next.enabled !== previous.enabled) eyeCareHandled.current = false
    automationRef.current = next
    setAutomationState(next)
    clearPrompt()
    persist()
  }, [clearPrompt, persist])

  const respondToPrompt = useCallback((choice: 'accept' | 'cancel' | 'disable') => {
    const proposal = promptRef.current
    if (!proposal) return
    if (proposal.kind === 'eyecare') {
      eyeCareHandled.current = true
      // Cancelling eye care must not immediately yield another color prompt.
      decisionRef.current.handledSchedule = scheduleTriggerKey(new Date(), automationRef.current)
    } else decisionRef.current.handledSchedule = proposal.key
    if (choice === 'accept') {
      if (proposal.kind === 'eyecare') temporaryEyeCare.current = true
      else baseThemeRef.current = proposal.theme
      display(proposal.theme)
    }
    if (choice === 'disable') {
      automationRef.current = { ...automationRef.current, enabled: false }
      setAutomationState(automationRef.current)
      setDisabledNotice(true)
    }
    clearPrompt()
    persist()
  }, [clearPrompt, display, persist])

  useEffect(() => {
    if (!ready) return
    const clock = activity.current
    const begin = () => {
      if (clock.startedAt === null) clock.startedAt = performance.now()
    }
    const pause = () => {
      if (clock.startedAt !== null) clock.accumulatedMs += Math.max(0, performance.now() - clock.startedAt)
      clock.startedAt = null
    }
    const stop = observeAppForeground((foreground) => {
      foregroundRef.current = foreground
      if (foreground) begin()
      else pause()
    })
    return () => {
      pause()
      stop()
    }
  }, [ready])

  useEffect(() => {
    if (!ready) return
    const evaluate = () => {
      if (!foregroundRef.current) return
      const clock = activity.current
      const usageMinutes = (clock.accumulatedMs + (clock.startedAt === null ? 0 : Math.max(0, performance.now() - clock.startedAt))) / 60_000
      const proposal = nextThemePrompt({ settings: automationRef.current, date: new Date(), theme: themeRef.current,
        usageMinutes, handledSchedule: decisionRef.current.handledSchedule, eyeCareHandled: eyeCareHandled.current,
        temporaryEyeCare: temporaryEyeCare.current })
      if (!proposal) { if (promptRef.current) clearPrompt(); return }
      if (promptRef.current?.key === proposal.key) return
      const index = nextReminderIndex(decisionRef.current.lastReminderIndex)
      decisionRef.current.lastReminderIndex = index
      const next = { ...proposal, reminder: EYECARE_REMINDERS[index] }
      promptRef.current = next
      setPrompt(next)
      persist()
    }
    evaluate()
    const timer = window.setInterval(evaluate, 15_000)
    window.addEventListener('focus', evaluate)
    document.addEventListener('visibilitychange', evaluate)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', evaluate)
      document.removeEventListener('visibilitychange', evaluate)
    }
  }, [ready, automation, clearPrompt, persist])

  return (
    <ThemeContext.Provider value={{ theme, automation, setAutomation, setTheme,
      cycleTheme: () => setTheme(THEME_ORDER[(THEME_ORDER.indexOf(themeRef.current) + 1) % THEME_ORDER.length]),
      prompt, respondToPrompt, disabledNotice, dismissDisabledNotice: () => setDisabledNotice(false) }}>
      {ready ? children : <div className="min-h-screen bg-background" aria-busy="true" />}
    </ThemeContext.Provider>
  )
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme 必须在 ThemeProvider 内使用')
  return ctx
}
