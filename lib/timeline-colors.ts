/** Timeline-only colors. The default strings preserve the existing themes exactly. */
export type TimelineColorTheme = 'light' | 'dark' | 'eyecare'

export interface TimelineColors {
  axis: string
  yearTick: string
  monthTick: string
  weekTick: string
  dayTick: string
  selected: string
  stageBand: string
}

export const DEFAULT_COLORS: TimelineColors = {
  axis: '', yearTick: '', monthTick: '', weekTick: '', dayTick: '', selected: '', stageBand: '',
}

export const COLOR_INTENSITY_RANGE = { min: 0.5, max: 2, default: 1 } as const

export const TIMELINE_COLOR_PRESETS = [
  { label: '主题默认', value: '' },
  { label: '竹青', value: '#4c7965' },
  { label: '湖蓝', value: '#47718a' },
  { label: '桂褐', value: '#946a45' },
  { label: '梅紫', value: '#80617e' },
] as const

export interface TimelineColorSettings {
  timelineTint: string
  colorIntensity: number
  colors: TimelineColors
}

/** Hex only; retain valid alpha colors from old preferences, reject malformed/injected CSS. */
export function normalizeTimelineColor(value: unknown): string {
  if (typeof value !== 'string') return ''
  if (/^#(?:[\da-f]{6}|[\da-f]{8})$/i.test(value)) return value.toLowerCase()
  if (/^#(?:[\da-f]{3}|[\da-f]{4})$/i.test(value)) {
    return `#${[...value.slice(1)].map((digit) => digit.repeat(2)).join('')}`.toLowerCase()
  }
  return ''
}

/** Older saved preferences have neither tint nor intensity; keep their individual overrides. */
export function sanitizeTimelineColorSettings(raw: unknown): TimelineColorSettings {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  const colors = { ...DEFAULT_COLORS }
  const savedColors = obj.colors && typeof obj.colors === 'object' && !Array.isArray(obj.colors)
    ? obj.colors as Record<string, unknown> : {}
  for (const key of Object.keys(colors) as (keyof TimelineColors)[]) {
    colors[key] = normalizeTimelineColor(savedColors[key])
  }
  const intensity = typeof obj.colorIntensity === 'number' && Number.isFinite(obj.colorIntensity)
    ? obj.colorIntensity : COLOR_INTENSITY_RANGE.default
  return {
    timelineTint: normalizeTimelineColor(obj.timelineTint),
    colorIntensity: Math.max(COLOR_INTENSITY_RANGE.min, Math.min(COLOR_INTENSITY_RANGE.max, intensity)),
    colors,
  }
}

function luminance(channels: number[]): number {
  const linear = channels.map((value) => {
    const channel = value / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
}

/**
 * Keep the chosen hue recognizable when a day/night switch changes the paper.
 * Very pale ink on light paper and very dark ink on dark paper are brought into
 * a legible luminance range. Default theme tokens never pass through this path.
 */
export function adaptTimelineInk(value: string, theme: TimelineColorTheme): string {
  const normalized = normalizeTimelineColor(value)
  if (!normalized) return ''
  const channels = [1, 3, 5].map((offset) => Number.parseInt(normalized.slice(offset, offset + 2), 16))
  const isDark = theme === 'dark'
  const target = isDark ? 0.48 : 0.14
  const fits = (candidate: number[]) => isDark ? luminance(candidate) >= target : luminance(candidate) <= target
  if (fits(channels)) return normalized
  // Find the smallest blend with white/black that meets the lightness bound.
  let lo = 0
  let hi = 1
  const end = isDark ? 255 : 0
  const blend = (amount: number) => channels.map((channel) => Math.round(channel + (end - channel) * amount))
  for (let step = 0; step < 20; step++) {
    const midpoint = (lo + hi) / 2
    if (fits(blend(midpoint))) hi = midpoint
    else lo = midpoint
  }
  return `#${blend(hi).map((channel) => channel.toString(16).padStart(2, '0')).join('')}${normalized.slice(7)}`
}

function alphaColor(ink: string, percentage: number): string {
  const amount = Math.round(Math.max(0, Math.min(100, percentage)) * 100) / 100
  return amount === 100 ? ink : `color-mix(in oklab, ${ink} ${amount}%, transparent)`
}

type ColorVariable = `--tlc-${string}`
type ColorRole = { variable: ColorVariable; token: 'foreground' | 'muted-foreground' | 'primary'; alpha: number; override?: keyof TimelineColors; label?: boolean }

const COLOR_ROLES: readonly ColorRole[] = [
  { variable: '--tlc-axis', token: 'foreground', alpha: 30, override: 'axis' },
  { variable: '--tlc-year', token: 'foreground', alpha: 32, override: 'yearTick' },
  { variable: '--tlc-month', token: 'foreground', alpha: 24, override: 'monthTick' },
  { variable: '--tlc-week', token: 'foreground', alpha: 18, override: 'weekTick' },
  { variable: '--tlc-day', token: 'foreground', alpha: 30, override: 'dayTick' },
  { variable: '--tlc-selected', token: 'primary', alpha: 100, override: 'selected' },
  { variable: '--tlc-year-label', token: 'muted-foreground', alpha: 80, override: 'yearTick', label: true },
  { variable: '--tlc-month-label', token: 'muted-foreground', alpha: 70, override: 'monthTick', label: true },
  { variable: '--tlc-week-label', token: 'muted-foreground', alpha: 50, override: 'weekTick', label: true },
  { variable: '--tlc-today-label', token: 'muted-foreground', alpha: 60, override: 'dayTick', label: true },
  { variable: '--tlc-node', token: 'foreground', alpha: 55 },
  { variable: '--tlc-node-label', token: 'muted-foreground', alpha: 100, label: true },
  { variable: '--tlc-node-label-selected', token: 'foreground', alpha: 100, override: 'selected', label: true },
  { variable: '--tlc-node-label-hover', token: 'foreground', alpha: 100, label: true },
  { variable: '--tlc-stage', token: 'primary', alpha: 15, override: 'stageBand' },
  { variable: '--tlc-stage-inactive', token: 'foreground', alpha: 4.5, override: 'stageBand' },
  { variable: '--tlc-stage-edge-active', token: 'primary', alpha: 40, override: 'stageBand' },
  { variable: '--tlc-stage-edge', token: 'foreground', alpha: 15, override: 'stageBand' },
  { variable: '--tlc-stage-label-active', token: 'foreground', alpha: 70, override: 'stageBand', label: true },
  { variable: '--tlc-stage-label', token: 'muted-foreground', alpha: 40, override: 'stageBand', label: true },
]

/** Set on the timeline section only: body/editor/menu colors are never affected. */
export function buildTimelineColorVars(raw: TimelineColorSettings, theme: TimelineColorTheme): Record<ColorVariable, string> {
  const settings = sanitizeTimelineColorSettings(raw)
  const tint = adaptTimelineInk(settings.timelineTint, theme)
  const variables: Record<ColorVariable, string> = {}
  for (const role of COLOR_ROLES) {
    const override = role.override ? adaptTimelineInk(settings.colors[role.override], theme) : ''
    let ink = override || tint || `var(--color-${role.token})`
    // Keep labels readable at the faintest setting while the ruler lines can be
    // deliberately quieter. Stronger settings deepen muted theme text as well.
    const depth = role.label && settings.colorIntensity < 1
      ? 0.8 + settings.colorIntensity * 0.2 : settings.colorIntensity
    if (!override && !tint && role.label && role.token === 'muted-foreground' && depth > 1) {
      const stronger = Math.round((depth - 1) * 45)
      ink = `color-mix(in oklab, var(--color-foreground) ${stronger}%, ${ink})`
    }
    // Existing per-part stroke overrides were opaque. Keep that interpretation;
    // labels/bands retain their hierarchy rather than becoming solid blocks.
    const opaqueOverride = override && !role.label && !role.variable.startsWith('--tlc-stage')
    const alpha = opaqueOverride ? 100 : role.alpha
    variables[role.variable] = alphaColor(ink, alpha * depth)
  }
  return variables
}
