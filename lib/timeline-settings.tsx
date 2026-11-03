'use client'

// 时间轴显示设置:几何引擎与时间尺 UI 的唯一输入源。
//
// 三条铁律:
//   1. 每个数值都有 clamp 边界 —— 任何异常值(手改 localStorage、旧版本数据)
//      都在读入时被夹回安全区间,不可能让页面崩坏。
//   2. 只存"显示参数",绝不涉及人生事件 / 阶段 / 正文等用户数据,
//      因此"恢复默认"在结构上就不可能误删内容。
//   3. 滚动收缩算法(threshold / easing / compact 目标)不在这里 ——
//      那是产品核心交互,不开放自定义。

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { loadDesktopPreferences, saveDesktopPreferences } from './preferences'
import { isDesktopRuntime } from './platform'
import { registerBeforePersistenceFlush } from './persistence/flush-barrier'
import { COLOR_INTENSITY_RANGE, DEFAULT_COLORS, normalizeTimelineColor, sanitizeTimelineColorSettings, type TimelineColors } from './timeline-colors'

export { DEFAULT_COLORS, type TimelineColors } from './timeline-colors'

/* ── 数值边界 ─────────────────────────────────────────── */

interface Range {
  min: number
  max: number
  default: number
}

export const SETTING_RANGES = {
  /** 空年份的基础水平距离(px,100% 长度下) */
  baseYearWidth: { min: 80, max: 320, default: 160 } satisfies Range,
  /** 内容年份在最低可读宽度之上追加的呼吸空间 */
  expansionRatio: { min: 0, max: 0.5, default: 0.1 } satisfies Range,
  /** 四级刻度高度(px,100% 宽度下) */
  yearTickHeight: { min: 24, max: 72, default: 44 } satisfies Range,
  monthTickHeight: { min: 14, max: 48, default: 26 } satisfies Range,
  weekTickHeight: { min: 8, max: 36, default: 16 } satisfies Range,
  dayTickHeight: { min: 4, max: 24, default: 9 } satisfies Range,
  /** 线条粗细(px)。独立于"宽度"缩放 */
  axisStrokeWidth: { min: 1, max: 4, default: 1 } satisfies Range,
  tickStrokeWidth: { min: 1, max: 3, default: 1 } satisfies Range,
  /** 标签字号(px) */
  yearLabelSize: { min: 10, max: 16, default: 12 } satisfies Range,
  eventLabelSize: { min: 11, max: 16, default: 13 } satisfies Range,
  /** 双维缩放(总览状态下用户手动设定的尺寸) */
  lengthScale: { min: 0.25, max: 3, default: 1 } satisfies Range,
  widthScale: { min: 0.7, max: 1.8, default: 1 } satisfies Range,
  /** 时间轴线条深浅;标签保留最低可读度 */
  colorIntensity: COLOR_INTENSITY_RANGE satisfies Range,
} as const

export type NumericSettingKey = keyof typeof SETTING_RANGES

export interface TimelineVisibility {
  months: boolean
  weeks: boolean
  days: boolean
  stageBands: boolean
  // 年刻度永远存在,没有开关
}

export interface TimelineSettings {
  baseYearWidth: number
  expansionRatio: number
  yearTickHeight: number
  monthTickHeight: number
  weekTickHeight: number
  dayTickHeight: number
  axisStrokeWidth: number
  tickStrokeWidth: number
  yearLabelSize: number
  eventLabelSize: number
  lengthScale: number
  widthScale: number
  colorIntensity: number
  /** 统一色调;空字符串保留当前主题。分项颜色优先。 */
  timelineTint: string
  colors: TimelineColors
  visibility: TimelineVisibility
  /** 手动收起时间轴的当前写作视图状态。 */
  timelineCollapsed: boolean
  /** 时间轴外观，与其他显示参数一同在本机保存。 */
  timelineStyle: 'plain' | 'seasons'
}

export const DEFAULT_VISIBILITY: TimelineVisibility = {
  months: true,
  weeks: true,
  days: true,
  stageBands: true,
}

export function defaultSettings(): TimelineSettings {
  const numeric = Object.fromEntries(
    Object.entries(SETTING_RANGES).map(([k, r]) => [k, r.default]),
  ) as Record<NumericSettingKey, number>
  return { ...numeric, timelineTint: '', colors: { ...DEFAULT_COLORS }, visibility: { ...DEFAULT_VISIBILITY }, timelineCollapsed: false, timelineStyle: 'seasons' }
}

const STORAGE_KEY = 'life-timeline-display-settings-v1'

function clampNumeric(key: NumericSettingKey, value: unknown): number {
  const r = SETTING_RANGES[key]
  const n = typeof value === 'number' && Number.isFinite(value) ? value : r.default
  return Math.min(r.max, Math.max(r.min, n))
}

/* ── 刻度层级不变量 ─────────────────────────────────────
   主轴【下方】的三级结构刻度长度必须递减:年 ≥ 月 ≥ 周(§14-§18)。
   这是时间粒度的视觉表达,也是三行标签能自然排开的前提 ——
   若月比年长,标签行会互相穿插,读者也无法从长度判断层级。

   日刻度不在其中:它朝【上】(§19),与结构刻度不共享坐标系,
   长度上不需要、也不应该受周刻度约束。

   传导方向以"用户刚拖动的那一级"为准,所以任何拖动都跟手:
     调大某级 → 更粗的粒度跟着抬高
     调小某级 → 更细的粒度跟着降低
   各级的 clamp 上下界本身是嵌套的,因此传导后不会越界。            */

const TICK_ORDER = [
  'yearTickHeight',
  'monthTickHeight',
  'weekTickHeight',
] as const satisfies readonly NumericSettingKey[]

function enforceTickOrder(
  settings: TimelineSettings,
  changed: NumericSettingKey,
): TimelineSettings {
  const idx = (TICK_ORDER as readonly NumericSettingKey[]).indexOf(changed)
  if (idx === -1) return settings
  const next = { ...settings }
  // 向粗粒度传导(上方各级不得比被改的这级更短)
  for (let i = idx - 1; i >= 0; i--) {
    const key = TICK_ORDER[i]
    const finer = TICK_ORDER[i + 1]
    if (next[key] < next[finer]) next[key] = clampNumeric(key, next[finer])
  }
  // 向细粒度传导(下方各级不得比被改的这级更长)
  for (let i = idx + 1; i < TICK_ORDER.length; i++) {
    const key = TICK_ORDER[i]
    const coarser = TICK_ORDER[i - 1]
    if (next[key] > next[coarser]) next[key] = clampNumeric(key, next[coarser])
  }
  return next
}

/** 从任意来源(localStorage / 旧版本)读入并全量净化 */
export function sanitizeSettings(raw: unknown): TimelineSettings {
  const base = defaultSettings()
  if (!raw || typeof raw !== 'object') return base
  const obj = raw as Record<string, unknown>
  for (const key of Object.keys(SETTING_RANGES) as NumericSettingKey[]) {
    base[key] = clampNumeric(key, obj[key])
  }
  Object.assign(base, sanitizeTimelineColorSettings(obj))
  const vis = obj.visibility as Record<string, unknown> | undefined
  if (vis) {
    for (const key of Object.keys(DEFAULT_VISIBILITY) as (keyof TimelineVisibility)[]) {
      if (typeof vis[key] === 'boolean') base.visibility[key] = vis[key] as boolean
    }
  }
  if (typeof obj.timelineCollapsed === 'boolean') base.timelineCollapsed = obj.timelineCollapsed
  base.timelineStyle = obj.timelineStyle === 'plain' ? 'plain' : 'seasons'
  // 手改过的 localStorage 或旧版本数据可能违反层级,以年为准向下压平
  return enforceTickOrder(base, 'yearTickHeight')
}

/* ── Context ─────────────────────────────────────────── */

interface TimelineSettingsStore {
  settings: TimelineSettings
  setNumeric: (key: NumericSettingKey, value: number) => void
  setColor: (key: keyof TimelineColors, value: string) => void
  /** 设置整体色调,清除分项覆盖,保留深浅与尺寸 */
  setTimelineTint: (value: string) => void
  /** 只恢复颜色和深浅,不修改尺寸和显示开关 */
  resetColors: () => void
  setVisibility: (key: keyof TimelineVisibility, value: boolean) => void
  setTimelineCollapsed: (value: boolean) => void
  setTimelineStyle: (value: TimelineSettings['timelineStyle']) => void
  /** 恢复默认(只重置显示设置)。返回可用于撤销的快照 */
  resetToDefaults: () => void
  /** 撤销最近一次"恢复默认" */
  undoReset: () => void
  /** 有可撤销的恢复操作时为 true(供 Toast 显示) */
  canUndoReset: boolean
}

const TimelineSettingsContext = createContext<TimelineSettingsStore | null>(null)

export function TimelineSettingsProvider({ children }: { children: ReactNode }) {
  // 首帧用默认值渲染,挂载后再读 localStorage —— 避免 SSR/CSR 不一致
  const [settings, setSettings] = useState<TimelineSettings>(defaultSettings)
  const [undoSnapshot, setUndoSnapshot] = useState<TimelineSettings | null>(null)
  const [ready, setReady] = useState(false)
  const settingsRef = useRef(settings)
  const loadedRef = useRef(false)
  const desktopRef = useRef(false)
  const pendingSettingsRef = useRef<TimelineSettings | null>(null)

  useEffect(() => {
    let cancelled = false
    desktopRef.current = isDesktopRuntime()
    const load = async () => {
      if (desktopRef.current) {
        try {
          const preferences = await loadDesktopPreferences()
          if (!cancelled && preferences) {
            settingsRef.current = sanitizeSettings(preferences.displaySettings)
            setSettings(settingsRef.current)
          }
        } catch (error) {
          // A damaged/unavailable preference row falls back to safe defaults,
          // but the failure remains visible in diagnostics and store status.
          console.error('[life-timeline] 无法读取时间轴显示设置', error)
        } finally {
          if (!cancelled) { loadedRef.current = true; setReady(true) }
        }
        return
      }
      try {
        const raw = localStorage.getItem(STORAGE_KEY)
        if (raw && !cancelled) {
          settingsRef.current = sanitizeSettings(JSON.parse(raw))
          setSettings(settingsRef.current)
        }
      } catch {
        // 损坏的存储直接忽略,继续用默认值
      }
      if (!cancelled) { loadedRef.current = true; setReady(true) }
    }
    void load()
    return () => { cancelled = true }
  }, [])

  // 持久化(去抖,避免拖动 slider 时每帧写盘)
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const persistPending = useCallback(async () => {
    if (!loadedRef.current) return
    if (persistTimer.current) clearTimeout(persistTimer.current)
    persistTimer.current = null
    const pending = pendingSettingsRef.current
    if (!pending) return
    if (desktopRef.current) await saveDesktopPreferences({ displaySettings: pending })
    else {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(pending)) }
      catch { /* 存储不可用时静默:设置仍在内存中生效 */ }
    }
    if (pendingSettingsRef.current === pending) pendingSettingsRef.current = null
  }, [])

  // 原生关闭/备份的共享屏障必须先把尚在300ms去抖内的外观变更送进保存队列。
  // 发生写入错误时保留pending并抛回关闭保护,不能只打印日志后丢掉设置。
  useEffect(() => registerBeforePersistenceFlush(persistPending), [persistPending])

  useEffect(() => {
    if (!loadedRef.current || settingsRef.current !== settings) return
    pendingSettingsRef.current = settings
    if (persistTimer.current) clearTimeout(persistTimer.current)
    persistTimer.current = setTimeout(() => {
      void persistPending().catch((error) => {
        console.error('[life-timeline] 无法保存时间轴显示设置', error)
      })
    }, 300)
    return () => {
      if (persistTimer.current) clearTimeout(persistTimer.current)
    }
  }, [settings, persistPending])

  const changeSettings = useCallback((change: (current: TimelineSettings) => TimelineSettings) => {
    const next = change(settingsRef.current)
    settingsRef.current = next
    // Native close may arrive before the next React effect: stage the exact
    // user choice in the same event handler, not after a 300ms timer/paint.
    pendingSettingsRef.current = next
    setSettings(next)
  }, [])

  const setNumeric = useCallback((key: NumericSettingKey, value: number) => {
    changeSettings((prev) =>
      enforceTickOrder({ ...prev, [key]: clampNumeric(key, value) }, key),
    )
  }, [changeSettings])

  const setColor = useCallback((key: keyof TimelineColors, value: string) => {
    changeSettings((prev) => ({ ...prev, colors: { ...prev.colors, [key]: normalizeTimelineColor(value) } }))
  }, [changeSettings])

  const setTimelineTint = useCallback((value: string) => {
    changeSettings((prev) => ({ ...prev, timelineTint: normalizeTimelineColor(value), colors: { ...DEFAULT_COLORS } }))
  }, [changeSettings])

  const resetColors = useCallback(() => {
    changeSettings((prev) => ({ ...prev, timelineTint: '', colorIntensity: COLOR_INTENSITY_RANGE.default, colors: { ...DEFAULT_COLORS } }))
  }, [changeSettings])

  const setVisibility = useCallback((key: keyof TimelineVisibility, value: boolean) => {
    changeSettings((prev) => ({ ...prev, visibility: { ...prev.visibility, [key]: value } }))
  }, [changeSettings])

  const setTimelineCollapsed = useCallback((value: boolean) => {
    changeSettings((prev) => ({ ...prev, timelineCollapsed: value }))
  }, [changeSettings])

  const setTimelineStyle = useCallback((value: TimelineSettings['timelineStyle']) => {
    changeSettings((prev) => ({ ...prev, timelineStyle: value }))
  }, [changeSettings])

  const resetToDefaults = useCallback(() => {
    setUndoSnapshot(settingsRef.current)
    changeSettings(defaultSettings)
  }, [changeSettings])

  const undoReset = useCallback(() => {
    if (undoSnapshot) changeSettings(() => undoSnapshot)
    setUndoSnapshot(null)
  }, [undoSnapshot, changeSettings])

  const value = useMemo(
    () => ({
      settings,
      setNumeric,
      setColor,
      setTimelineTint,
      resetColors,
      setVisibility,
      setTimelineCollapsed,
      setTimelineStyle,
      resetToDefaults,
      undoReset,
      canUndoReset: undoSnapshot !== null,
    }),
    [settings, setNumeric, setColor, setTimelineTint, resetColors, setVisibility, setTimelineCollapsed, setTimelineStyle, resetToDefaults, undoReset, undoSnapshot],
  )

  return (
    <TimelineSettingsContext.Provider value={value}>{ready ? children : <div className="min-h-screen bg-background" aria-busy="true" />}</TimelineSettingsContext.Provider>
  )
}

export function useTimelineSettings(): TimelineSettingsStore {
  const ctx = useContext(TimelineSettingsContext)
  if (!ctx) throw new Error('useTimelineSettings 必须在 TimelineSettingsProvider 内使用')
  return ctx
}
