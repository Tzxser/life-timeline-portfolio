import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_COLORS,
  TIMELINE_COLOR_PRESETS,
  adaptTimelineInk,
  buildTimelineColorVars,
  normalizeTimelineColor,
  sanitizeTimelineColorSettings,
  type TimelineColorSettings,
  type TimelineColorTheme,
} from '../lib/timeline-colors'

const settings = (patch: Partial<TimelineColorSettings> = {}): TimelineColorSettings => ({
  timelineTint: '', colorIntensity: 1, colors: { ...DEFAULT_COLORS }, ...patch,
})

function luminance(color: string): number {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16) / 255)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
}

test('old display preferences preserve individual colors and gain neutral appearance defaults', () => {
  const old = sanitizeTimelineColorSettings({ widthScale: 1.2, colors: { axis: '#A5b', selected: '#789a' } })
  assert.equal(old.timelineTint, '')
  assert.equal(old.colorIntensity, 1)
  assert.equal(old.colors.axis, '#aa55bb')
  assert.equal(old.colors.selected, '#778899aa')
  assert.equal(old.colors.yearTick, '')
  assert.deepEqual(sanitizeTimelineColorSettings(null), settings())
})

test('color normalization accepts valid legacy alpha hex while rejecting malformed CSS values', () => {
  assert.equal(normalizeTimelineColor('#12345678'), '#12345678')
  assert.equal(normalizeTimelineColor('#AbCdEf'), '#abcdef')
  for (const raw of ['#12345', '#1234567', '#123456789', '#ggg', 'red', 'var(--foreground)', 'url(https://example.test)', '#112233; color:red', null, 0, ['#fff']]) {
    assert.equal(normalizeTimelineColor(raw), '')
  }
  const result = sanitizeTimelineColorSettings({ timelineTint: '#12345', colorIntensity: Number.NaN, colors: ['#fff'] })
  assert.deepEqual(result, settings())
})

test('unchanged appearance retains the existing theme tokens and all opacity levels', () => {
  for (const theme of ['light', 'dark', 'eyecare'] as const) {
    const vars = buildTimelineColorVars(settings(), theme)
    assert.equal(vars['--tlc-axis'], 'color-mix(in oklab, var(--color-foreground) 30%, transparent)')
    assert.equal(vars['--tlc-year'], 'color-mix(in oklab, var(--color-foreground) 32%, transparent)')
    assert.equal(vars['--tlc-year-label'], 'color-mix(in oklab, var(--color-muted-foreground) 80%, transparent)')
    assert.equal(vars['--tlc-node-label'], 'var(--color-muted-foreground)')
    assert.equal(vars['--tlc-node-label-selected'], 'var(--color-foreground)')
    assert.equal(vars['--tlc-selected'], 'var(--color-primary)')
    assert.equal(vars['--tlc-stage-inactive'], 'color-mix(in oklab, var(--color-foreground) 4.5%, transparent)')
    assert.ok(Object.keys(vars).every((key) => key.startsWith('--tlc-')), 'no global theme/editor variables may be written')
  }
})

test('every chosen ink stays visible on all three papers, including black and white extremes', () => {
  const colors = [...TIMELINE_COLOR_PRESETS.map((preset) => preset.value).filter(Boolean), '#ffffff', '#000000', '#ffff00', '#00ffff', '#0000ff']
  for (const theme of ['light', 'dark', 'eyecare'] as const) {
    for (const chosen of colors) {
      const ink = adaptTimelineInk(chosen, theme)
      assert.match(ink, /^#[\da-f]{6}$/)
      assert.ok(theme === 'dark' ? luminance(ink) >= 0.479 : luminance(ink) <= 0.141, `${theme} ${chosen} -> ${ink}`)
    }
  }
  assert.equal(adaptTimelineInk('#112233aa', 'dark').slice(7), 'aa', 'legacy opacity is not lost during a theme change')
  assert.equal(adaptTimelineInk('#112233', 'light'), '#112233', 'a legible user-selected shade needs no adjustment')
  assert.equal(adaptTimelineInk('#eeeeee', 'dark'), '#eeeeee')
})

test('theme switching recomputes the chosen palette without changing saved color or diary styling', () => {
  const saved = settings({ timelineTint: '#4c7965', colorIntensity: 1.35 })
  const before = structuredClone(saved)
  const palettes = ['light', 'dark', 'eyecare'].map((theme) => buildTimelineColorVars(saved, theme as TimelineColorTheme))
  assert.notEqual(palettes[0]['--tlc-year'], palettes[1]['--tlc-year'])
  assert.notEqual(palettes[0]['--tlc-node-label'], 'var(--color-muted-foreground)')
  assert.deepEqual(saved, before)
  assert.ok(palettes.every((palette) => !Object.hasOwn(palette, '--foreground') && !Object.hasOwn(palette, '--background')))
})

test('depth is bounded and labels remain readable when ruler lines are made faint', () => {
  const low = buildTimelineColorVars(settings({ colorIntensity: -100 }), 'light')
  const high = buildTimelineColorVars(settings({ colorIntensity: 100 }), 'light')
  assert.equal(low['--tlc-axis'], 'color-mix(in oklab, var(--color-foreground) 15%, transparent)')
  assert.equal(high['--tlc-axis'], 'color-mix(in oklab, var(--color-foreground) 60%, transparent)')
  assert.equal(low['--tlc-year-label'], 'color-mix(in oklab, var(--color-muted-foreground) 72%, transparent)')
  assert.deepEqual(buildTimelineColorVars(settings({ colorIntensity: Number.NaN }), 'light'), buildTimelineColorVars(settings(), 'light'))
})

test('a per-part color overrides its shared tint and also colors its corresponding label', () => {
  const vars = buildTimelineColorVars(settings({ timelineTint: '#4c7965', colors: { ...DEFAULT_COLORS, yearTick: '#733355' } }), 'light')
  assert.equal(vars['--tlc-year'], '#733355')
  assert.equal(vars['--tlc-year-label'], 'color-mix(in oklab, #733355 80%, transparent)')
  assert.notEqual(vars['--tlc-month'], vars['--tlc-year'])
})
