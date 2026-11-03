/**
 * Pure rules for the local automatic theme mode.
 *
 * The React theme provider deliberately remains responsible for applying a
 * class to <html>.  This module only answers which theme should be selected
 * from a clock and a continuous-use duration, so it can be used by the
 * desktop UI without a network or a browser API dependency.
 */

export type AutomaticTheme = 'light' | 'dark' | 'eyecare'

export interface ThemeAutomationSettings {
  /** Master switch. When false, automatic mode yields no theme. */
  enabled: boolean
  /** Switch for the day/night clock schedule. */
  scheduleEnabled: boolean
  /** Switch for the continuous-use eye-care timeout. */
  eyeCareEnabled: boolean
  /** Local time at which the light theme starts, in minutes after midnight. */
  dayStartMinutes: number
  /** Local time at which the dark theme starts, in minutes after midnight. */
  nightStartMinutes: number
  /** Continuous-use duration before eye-care mode is selected. */
  eyeCareAfterMinutes: number
}

export const MINUTES_PER_DAY = 24 * 60
export const MIN_EYECARE_AFTER_MINUTES = 5
export const MAX_EYECARE_AFTER_MINUTES = 12 * 60

/** Local defaults: daylight 07:00–19:00 and eye care after 30 active minutes. */
export const DEFAULT_THEME_AUTOMATION_SETTINGS: ThemeAutomationSettings = {
  enabled: true,
  scheduleEnabled: true,
  eyeCareEnabled: true,
  dayStartMinutes: 7 * 60,
  nightStartMinutes: 19 * 60,
  eyeCareAfterMinutes: 30,
}

type ThemeAutomationSettingsPatch = Partial<ThemeAutomationSettings> | null | undefined

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function readInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)))
}

/**
 * Clean values read from SQLite/localStorage or an older desktop version.
 * Unknown keys are ignored and invalid fields fall back independently, so a
 * partially written preference cannot turn off the rest of the app.
 */
export function normalizeThemeAutomationSettings(input: unknown): ThemeAutomationSettings {
  const patch: ThemeAutomationSettingsPatch = isRecord(input)
    ? input as ThemeAutomationSettingsPatch
    : undefined

  return {
    enabled: readBoolean(patch?.enabled, DEFAULT_THEME_AUTOMATION_SETTINGS.enabled),
    scheduleEnabled: readBoolean(patch?.scheduleEnabled, DEFAULT_THEME_AUTOMATION_SETTINGS.scheduleEnabled),
    eyeCareEnabled: readBoolean(patch?.eyeCareEnabled, DEFAULT_THEME_AUTOMATION_SETTINGS.eyeCareEnabled),
    dayStartMinutes: readInteger(
      patch?.dayStartMinutes,
      DEFAULT_THEME_AUTOMATION_SETTINGS.dayStartMinutes,
      0,
      MINUTES_PER_DAY - 1,
    ),
    nightStartMinutes: readInteger(
      patch?.nightStartMinutes,
      DEFAULT_THEME_AUTOMATION_SETTINGS.nightStartMinutes,
      0,
      MINUTES_PER_DAY - 1,
    ),
    eyeCareAfterMinutes: readInteger(
      patch?.eyeCareAfterMinutes,
      DEFAULT_THEME_AUTOMATION_SETTINGS.eyeCareAfterMinutes,
      MIN_EYECARE_AFTER_MINUTES,
      MAX_EYECARE_AFTER_MINUTES,
    ),
  }
}

/** Return a local Date's clock position as minutes after midnight. */
export function clockMinutesForDate(date: Date): number {
  const hours = date.getHours()
  const minutes = date.getMinutes()
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return 0
  return normalizeClockMinutes(hours * 60 + minutes)
}

/** Keep arbitrary clock input inside one local day. */
export function normalizeClockMinutes(value: number): number {
  if (!Number.isFinite(value)) return 0
  const integer = Math.trunc(value)
  return ((integer % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY
}

/**
 * Pick light or dark from a local clock position.  The comparison also works
 * when the user chooses a schedule that crosses midnight (for example, a
 * daylight window from 20:00 to 06:00).
 */
export function getScheduledTheme(
  clockMinutes: number,
  settings: Pick<ThemeAutomationSettings, 'dayStartMinutes' | 'nightStartMinutes'>,
): Exclude<AutomaticTheme, 'eyecare'> {
  const clock = normalizeClockMinutes(clockMinutes)
  const dayStart = normalizeClockMinutes(settings.dayStartMinutes)
  const nightStart = normalizeClockMinutes(settings.nightStartMinutes)

  if (dayStart === nightStart) return 'light'

  const isDay = dayStart < nightStart
    ? clock >= dayStart && clock < nightStart
    : clock >= dayStart || clock < nightStart
  return isDay ? 'light' : 'dark'
}

/** Whether the eye-care threshold has been reached for this session. */
export function shouldActivateEyecare(
  continuousUsageMinutes: number,
  settings: Pick<ThemeAutomationSettings, 'eyeCareAfterMinutes'>
    & Partial<Pick<ThemeAutomationSettings, 'eyeCareEnabled'>>,
): boolean {
  if (settings.eyeCareEnabled === false) return false
  if (!Number.isFinite(continuousUsageMinutes)) return false
  return Math.max(0, continuousUsageMinutes) >= settings.eyeCareAfterMinutes
}

export interface ResolveAutomaticThemeInput {
  settings: ThemeAutomationSettings
  /** Supply this in callers/tests to avoid relying on the current wall clock. */
  date?: Date
  /** Optional clock override, useful for a scheduler tick or deterministic tests. */
  clockMinutes?: number
  /** Continuous active-use duration for the current session, in minutes. */
  continuousUsageMinutes?: number
}

/**
 * Resolve one automatic theme decision.  `null` means that the master switch
 * is off and the caller should preserve the user's manually selected theme.
 */
export function resolveAutomaticTheme({
  settings,
  date,
  clockMinutes,
  continuousUsageMinutes = 0,
}: ResolveAutomaticThemeInput): AutomaticTheme | null {
  const normalized = normalizeThemeAutomationSettings(settings)
  if (!normalized.enabled) return null

  if (normalized.eyeCareEnabled && shouldActivateEyecare(continuousUsageMinutes, normalized)) {
    return 'eyecare'
  }

  if (!normalized.scheduleEnabled) return null

  const clock = clockMinutes ?? (date ? clockMinutesForDate(date) : clockMinutesForDate(new Date()))
  return getScheduledTheme(clock, normalized)
}

/** The actual schedule boundary, not the calendar date: midnight alone is not
 * another trigger. Include the schedule so changing its times is a new choice. */
export function scheduleTriggerKey(date: Date, settings: ThemeAutomationSettings): string {
  const theme = getScheduledTheme(clockMinutesForDate(date), settings)
  const minutes = theme === 'light' ? settings.dayStartMinutes : settings.nightStartMinutes
  const boundary = new Date(date.getFullYear(), date.getMonth(), date.getDate(), Math.floor(minutes / 60), minutes % 60)
  if (boundary.getTime() > date.getTime()) boundary.setDate(boundary.getDate() - 1)
  return `${settings.dayStartMinutes}/${settings.nightStartMinutes}/${boundary.getTime()}/${theme}`
}

export interface AutomaticThemePrompt {
  kind: 'schedule' | 'eyecare'
  key: string
  theme: AutomaticTheme
}

/** No theme is applied here. Both automatic rules only propose a change. */
export function nextThemePrompt(input: {
  settings: ThemeAutomationSettings
  date: Date
  theme: AutomaticTheme
  usageMinutes: number
  handledSchedule: string | null
  eyeCareHandled: boolean
  temporaryEyeCare: boolean
}): AutomaticThemePrompt | null {
  const { settings, date, theme } = input
  if (!settings.enabled || input.temporaryEyeCare) return null
  if (!input.eyeCareHandled && theme !== 'eyecare' && shouldActivateEyecare(input.usageMinutes, settings)) {
    return { kind: 'eyecare', key: `usage/${settings.eyeCareAfterMinutes}`, theme: 'eyecare' }
  }
  const key = scheduleTriggerKey(date, settings)
  const scheduled = getScheduledTheme(clockMinutesForDate(date), settings)
  return settings.scheduleEnabled && input.handledSchedule !== key && theme !== scheduled
    ? { kind: 'schedule', key, theme: scheduled }
    : null
}

export const EYECARE_REMINDERS = [
  '记录生活的同时，也给眼睛一点休息时间。',
  '写到这里，不妨眨眨眼，看看远处。',
  '故事可以慢慢写，目光也需要歇一歇。',
  '留住今天的片刻，也记得照顾此刻的自己。',
] as const

export function nextReminderIndex(previous: number, random = Math.random()): number {
  const choices = EYECARE_REMINDERS.map((_, index) => index).filter((index) => index !== previous)
  return choices[Math.min(choices.length - 1, Math.max(0, Math.floor(random * choices.length)))]
}

/** Migrate only the old 60-minute default. Other user-chosen durations survive. */
export function migrateThemeAutomation(input: unknown, rulesVersion: unknown): ThemeAutomationSettings {
  const settings = normalizeThemeAutomationSettings(input)
  return rulesVersion !== 2 && settings.eyeCareAfterMinutes === 60
    ? { ...settings, eyeCareAfterMinutes: 30 }
    : settings
}

