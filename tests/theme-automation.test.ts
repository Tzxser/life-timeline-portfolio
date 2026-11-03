import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_THEME_AUTOMATION_SETTINGS,
  MAX_EYECARE_AFTER_MINUTES,
  MIN_EYECARE_AFTER_MINUTES,
  getScheduledTheme,
  normalizeThemeAutomationSettings,
  resolveAutomaticTheme,
  shouldActivateEyecare,
  nextThemePrompt,
  nextReminderIndex,
  scheduleTriggerKey,
  migrateThemeAutomation,
  type ThemeAutomationSettings,
} from '../lib/theme-automation'

const settings = (patch: Partial<ThemeAutomationSettings> = {}): ThemeAutomationSettings => ({
  ...DEFAULT_THEME_AUTOMATION_SETTINGS,
  ...patch,
})

test('scheduled theme uses light during the configured day and dark overnight', () => {
  const schedule = { dayStartMinutes: 7 * 60, nightStartMinutes: 19 * 60 }

  assert.equal(getScheduledTheme(7 * 60, schedule), 'light')
  assert.equal(getScheduledTheme(12 * 60, schedule), 'light')
  assert.equal(getScheduledTheme(19 * 60, schedule), 'dark')
  assert.equal(getScheduledTheme(23 * 60 + 59, schedule), 'dark')
  assert.equal(getScheduledTheme(6 * 60 + 59, schedule), 'dark')
})

test('scheduled theme supports an overnight day window when the configured times wrap', () => {
  const schedule = { dayStartMinutes: 22 * 60, nightStartMinutes: 6 * 60 }

  assert.equal(getScheduledTheme(23 * 60, schedule), 'light')
  assert.equal(getScheduledTheme(5 * 60 + 59, schedule), 'light')
  assert.equal(getScheduledTheme(6 * 60, schedule), 'dark')
  assert.equal(getScheduledTheme(12 * 60, schedule), 'dark')
})

test('eye-care activates at the configured continuous-use threshold, but not before it', () => {
  const configured = settings({ eyeCareEnabled: true, eyeCareAfterMinutes: 60 })

  assert.equal(shouldActivateEyecare(59.99, configured), false)
  assert.equal(shouldActivateEyecare(60, configured), true)
  assert.equal(shouldActivateEyecare(120, configured), true)
})

test('disabled automation never changes the current theme', () => {
  const now = new Date(2026, 8, 30, 23, 30)

  assert.equal(resolveAutomaticTheme({
    date: now,
    continuousUsageMinutes: 90,
    settings: settings({ enabled: false }),
  }), null)
  assert.equal(resolveAutomaticTheme({
    date: now,
    continuousUsageMinutes: 90,
    settings: settings({ scheduleEnabled: false, eyeCareEnabled: false }),
  }), null)
})

test('eye-care takes precedence over the day/night schedule once the threshold is reached', () => {
  const now = new Date(2026, 8, 30, 12, 0)

  assert.equal(resolveAutomaticTheme({
    date: now,
    continuousUsageMinutes: 60,
    settings: settings(),
  }), 'eyecare')
  assert.equal(resolveAutomaticTheme({
    date: now,
    continuousUsageMinutes: 29,
    settings: settings(),
  }), 'light')
})

test('normalization rejects malformed values and keeps every time value in range', () => {
  const normalized = normalizeThemeAutomationSettings({
    enabled: 'yes',
    scheduleEnabled: 0,
    eyeCareEnabled: null,
    dayStartMinutes: -20,
    nightStartMinutes: 2_000,
    eyeCareAfterMinutes: Number.NaN,
  })

  assert.equal(normalized.enabled, DEFAULT_THEME_AUTOMATION_SETTINGS.enabled)
  assert.equal(normalized.scheduleEnabled, DEFAULT_THEME_AUTOMATION_SETTINGS.scheduleEnabled)
  assert.equal(normalized.eyeCareEnabled, DEFAULT_THEME_AUTOMATION_SETTINGS.eyeCareEnabled)
  assert.equal(normalized.dayStartMinutes, 0)
  assert.equal(normalized.nightStartMinutes, 1_439)
  assert.equal(normalized.eyeCareAfterMinutes, DEFAULT_THEME_AUTOMATION_SETTINGS.eyeCareAfterMinutes)

  const bounded = normalizeThemeAutomationSettings({
    dayStartMinutes: 100.9,
    nightStartMinutes: 200.1,
    eyeCareAfterMinutes: 60.5,
  })
  assert.equal(bounded.dayStartMinutes, 100)
  assert.equal(bounded.nightStartMinutes, 200)
  assert.equal(bounded.eyeCareAfterMinutes, 60)

  assert.equal(normalizeThemeAutomationSettings({ eyeCareAfterMinutes: 0 }).eyeCareAfterMinutes, MIN_EYECARE_AFTER_MINUTES)
  assert.equal(normalizeThemeAutomationSettings({ eyeCareAfterMinutes: 10_000 }).eyeCareAfterMinutes, MAX_EYECARE_AFTER_MINUTES)
})

test('normalization supplies defaults for an absent settings object', () => {
  assert.deepEqual(normalizeThemeAutomationSettings(undefined), DEFAULT_THEME_AUTOMATION_SETTINGS)
  assert.deepEqual(normalizeThemeAutomationSettings(null), DEFAULT_THEME_AUTOMATION_SETTINGS)
})

test('30 minute migration changes the old default once and preserves custom durations', () => {
  assert.equal(DEFAULT_THEME_AUTOMATION_SETTINGS.eyeCareAfterMinutes, 30)
  assert.equal(migrateThemeAutomation({ eyeCareAfterMinutes: 60 }, undefined).eyeCareAfterMinutes, 30)
  assert.equal(migrateThemeAutomation({ eyeCareAfterMinutes: 45 }, undefined).eyeCareAfterMinutes, 45)
  assert.equal(migrateThemeAutomation({ eyeCareAfterMinutes: 60 }, 2).eyeCareAfterMinutes, 60)
})

test('schedule identity crosses midnight without re-prompting the same night', () => {
  assert.equal(scheduleTriggerKey(new Date(2026, 9, 13, 23), settings()), scheduleTriggerKey(new Date(2026, 9, 14, 6), settings()))
  assert.notEqual(scheduleTriggerKey(new Date(2026, 9, 14, 6, 59), settings()), scheduleTriggerKey(new Date(2026, 9, 14, 7), settings()))
})

test('each automated change requires a new unhandled proposal; temporary eye care survives day boundaries', () => {
  const date = new Date(2026, 9, 13, 20)
  const input = { settings: settings(), date, theme: 'light' as const, usageMinutes: 0, handledSchedule: null, eyeCareHandled: false, temporaryEyeCare: false }
  const night = nextThemePrompt(input)!
  assert.equal(night.theme, 'dark')
  assert.equal(nextThemePrompt({ ...input, handledSchedule: night.key }), null)
  const eye = nextThemePrompt({ ...input, usageMinutes: 30 })!
  assert.equal(eye.kind, 'eyecare')
  assert.equal(nextThemePrompt({ ...input, usageMinutes: 90, eyeCareHandled: true, handledSchedule: night.key }), null)
  assert.equal(nextThemePrompt({ ...input, usageMinutes: 90, temporaryEyeCare: true, date: new Date(2026, 9, 14, 8) }), null)
  assert.equal(nextThemePrompt({ ...input, usageMinutes: 90, settings: settings({ enabled: false }) }), null)
  assert.equal(nextThemePrompt({ ...input, theme: 'dark' }), null)
})

test('warm reminder selection never immediately repeats, including random endpoints', () => {
  for (let last = 0; last < 4; last++) for (const random of [0, 0.1, 0.5, 0.999999, 1]) {
    const next = nextReminderIndex(last, random)
    assert.notEqual(next, last)
    assert(next >= 0 && next < 4)
  }
})
