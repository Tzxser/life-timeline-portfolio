'use client'

// 时间轴显示设置:右侧 Drawer(§38-§52)
//
// 实时预览的实现极其直接:设置即应用状态 —— slider 每一步都写进
// TimelineSettingsProvider,几何引擎与时间尺立即响应,不存在"预览副本"。
// 持久化在 Provider 里做了去抖,拖动过程不会每帧写盘。
//
// 「恢复默认」只重置显示设置(设置模型在结构上就不含用户数据),
// 并提供一次性的撤销(§50-§52)。

import { useEffect, useRef, useState } from 'react'
import { RotateCcw, X } from 'lucide-react'
import { Overlay } from '@/components/common/overlay'
import {
  SETTING_RANGES,
  useTimelineSettings,
  type NumericSettingKey,
  type TimelineColors,
  type TimelineVisibility,
} from '@/lib/timeline-settings'
import { LocalDataSection } from './local-data-section'
import { useStartupPreferences } from '@/lib/startup-preferences'
import { THEME_LABEL, useTheme } from '@/lib/theme'
import { MAX_EYECARE_AFTER_MINUTES, MIN_EYECARE_AFTER_MINUTES } from '@/lib/theme-automation'
import { UpdateSettingsSection } from '@/components/updates/update-settings-section'
import { TIMELINE_COLOR_PRESETS, buildTimelineColorVars } from '@/lib/timeline-colors'

interface TimelineSettingsDrawerProps {
  open: boolean
  onClose: () => void
}

const fieldLabel = 'text-xs font-medium tracking-wide text-muted-foreground'
const sectionTitle = 'font-serif text-sm text-foreground'

/* 滑杆条目定义:分组呈现,标签用人话,不暴露内部参数名 */
const SIZE_ITEMS: Array<{ key: NumericSettingKey; label: string; format: (v: number) => string; step?: number }> = [
  { key: 'lengthScale', label: '长度(横向密度)', format: (v) => `${Math.round(v * 100)}%`, step: 0.05 },
  { key: 'widthScale', label: '宽度(刻度高度)', format: (v) => `${Math.round(v * 100)}%`, step: 0.05 },
  { key: 'baseYearWidth', label: '空年份的间距', format: (v) => `${Math.round(v)}px` },
]

const TICK_ITEMS: Array<{ key: NumericSettingKey; label: string; format: (v: number) => string }> = [
  { key: 'yearTickHeight', label: '年刻度高度', format: (v) => `${Math.round(v)}px` },
  { key: 'monthTickHeight', label: '月刻度高度', format: (v) => `${Math.round(v)}px` },
  { key: 'weekTickHeight', label: '周刻度高度', format: (v) => `${Math.round(v)}px` },
  { key: 'dayTickHeight', label: '日刻度高度', format: (v) => `${Math.round(v)}px` },
  { key: 'axisStrokeWidth', label: '主轴粗细', format: (v) => `${v}px` },
  { key: 'tickStrokeWidth', label: '刻度粗细', format: (v) => `${v}px` },
  { key: 'yearLabelSize', label: '年份字号', format: (v) => `${Math.round(v)}px` },
  { key: 'eventLabelSize', label: '事件标题字号', format: (v) => `${Math.round(v)}px` },
]

const VISIBILITY_ITEMS: Array<{ key: keyof TimelineVisibility; label: string; hint: string }> = [
  { key: 'months', label: '月刻度', hint: '只出现在有记录的月份' },
  { key: 'weeks', label: '周刻度', hint: '只出现在有记录的周' },
  { key: 'days', label: '日刻度', hint: '悬停可预览当天的记录' },
  { key: 'stageBands', label: '阶段区间条', hint: '时间轴下方的人生阶段色带' },
]

const COLOR_ITEMS: Array<{ key: keyof TimelineColors; label: string }> = [
  { key: 'axis', label: '主轴' },
  { key: 'yearTick', label: '年刻度' },
  { key: 'monthTick', label: '月刻度' },
  { key: 'weekTick', label: '周刻度' },
  { key: 'dayTick', label: '日刻度' },
  { key: 'selected', label: '当前选中' },
  { key: 'stageBand', label: '阶段条' },
]

export function TimelineSettingsDrawer({ open, onClose }: TimelineSettingsDrawerProps) {
  const { settings, setNumeric, setColor, setTimelineTint, resetColors, setVisibility, resetToDefaults, undoReset, canUndoReset } =
    useTimelineSettings()
  const { showSeasonalSplash, setShowSeasonalSplash } = useStartupPreferences()
  const { theme, automation, setAutomation } = useTheme()
  const colorVars = buildTimelineColorVars(settings, theme)
  const hasPartColors = Object.values(settings.colors).some(Boolean)

  /* 「已恢复默认」提示条:出现在抽屉底部,可撤销,8 秒后自动消失 */
  const [showUndo, setShowUndo] = useState(false)
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    return () => {
      if (undoTimer.current) clearTimeout(undoTimer.current)
    }
  }, [])

  const handleReset = () => {
    resetToDefaults()
    setShowUndo(true)
    if (undoTimer.current) clearTimeout(undoTimer.current)
    undoTimer.current = setTimeout(() => setShowUndo(false), 8000)
  }

  return (
    <Overlay open={open} onClose={onClose} align="right" label="时间轴显示设置">
      <div className="flex h-full w-[24rem] max-w-[92vw] flex-col bg-background shadow-xl">
        <header className="flex items-center justify-between border-b border-border/70 px-6 py-4">
          <div className="flex flex-col">
            <h2 className="font-serif text-lg text-foreground">时间轴显示</h2>
            <p className="text-xs text-muted-foreground/70">改动即时生效,只影响外观,不动任何记录</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="关闭"
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="flex flex-1 flex-col gap-8 overflow-y-auto px-6 py-6">
          {/* ── 颜色:集中放在尺寸之前,无需翻过所有刻度滑杆寻找 ── */}
          <section className="flex flex-col gap-3" aria-label="时间轴颜色">
            <div className="flex items-center justify-between gap-2">
              <h3 className={sectionTitle}>时间轴颜色</h3>
              <button
                type="button"
                onClick={resetColors}
                className="rounded px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                恢复主题配色
              </button>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground/70">
              只调整时间轴、刻度与标签。亮色、暗色和护眼模式下会自动适应纸面。
            </p>
            <div className="grid grid-cols-3 gap-2" role="group" aria-label="时间轴配色预设">
              {TIMELINE_COLOR_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  aria-pressed={!hasPartColors && settings.timelineTint === preset.value}
                  onClick={() => setTimelineTint(preset.value)}
                  className={`inline-flex items-center justify-center gap-1.5 rounded-md border px-2 py-2 text-xs transition-colors ${!hasPartColors && settings.timelineTint === preset.value ? 'border-primary/60 bg-primary/5 text-foreground' : 'border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground'}`}
                >
                  <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full" style={{ background: preset.value || 'var(--primary)' }} />
                  {preset.label}
                </button>
              ))}
            </div>
            <label className="flex cursor-pointer items-center justify-between rounded-md border border-border px-3 py-2">
              <span className="text-sm text-foreground">自选色调</span>
              <span className="flex items-center gap-2">
                <span className="text-[11px] text-muted-foreground/70">
                  {hasPartColors ? '分项调整中' : settings.timelineTint ? '已应用' : '跟随主题'}
                </span>
                <input
                  type="color"
                  value={settings.timelineTint.slice(0, 7) || '#4c7965'}
                  onChange={(event) => setTimelineTint(event.target.value)}
                  aria-label="自选时间轴色调"
                  className="size-7 cursor-pointer rounded border border-border bg-transparent p-0"
                />
              </span>
            </label>
            <div className="relative h-20 overflow-hidden rounded-md border border-border bg-background" style={colorVars} aria-label="时间轴颜色预览">
              <div className="absolute top-5 right-5 left-5 h-px" style={{ background: 'var(--tlc-axis)' }} />
              <span className="absolute top-5 left-1/4 h-5 w-px" style={{ background: 'var(--tlc-year)' }} />
              <span className="absolute top-11 left-1/4 -translate-x-1/2 font-mono text-[10px]" style={{ color: 'var(--tlc-year-label)' }}>2026</span>
              <span className="absolute top-5 left-1/2 h-3 w-px" style={{ background: 'var(--tlc-month)' }} />
              <span className="absolute top-5 left-3/4 h-5 w-px" style={{ background: 'var(--tlc-year)' }} />
              <span className="absolute top-11 left-3/4 -translate-x-1/2 font-mono text-[10px]" style={{ color: 'var(--tlc-year-label)' }}>2027</span>
              <span className="absolute top-2 left-1/2 h-3 w-px" style={{ background: 'var(--tlc-selected)' }} />
            </div>
            <div className="flex flex-col gap-1">
              <SettingSlider
                id="tl-set-colorIntensity"
                label="颜色深浅"
                value={settings.colorIntensity}
                display={`${Math.round(settings.colorIntensity * 100)}%`}
                range={SETTING_RANGES.colorIntensity}
                step={0.05}
                onChange={(value) => setNumeric('colorIntensity', value)}
              />
              <div className="flex justify-between text-[11px] text-muted-foreground/60"><span>更淡</span><span>更深</span></div>
            </div>
            <details className="rounded-md border border-border px-3 py-2">
              <summary className="cursor-pointer text-xs text-muted-foreground transition-colors hover:text-foreground">分别调整颜色</summary>
              <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground/60">分项优先于整体色调；重新选择上方配色会统一应用。</p>
              <div className="mt-2 flex flex-col gap-1.5">
                {COLOR_ITEMS.map(({ key, label }) => {
                  const value = settings.colors[key]
                  return (
                    <div key={key} className="flex items-center justify-between gap-2 py-1">
                      <span className="text-sm text-foreground">{label}</span>
                      <span className="flex items-center gap-2">
                        {value ? (
                          <button type="button" onClick={() => setColor(key, '')} aria-label={`${label}跟随整体色调`} className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">跟随整体</button>
                        ) : <span className="text-[11px] text-muted-foreground/50">跟随整体</span>}
                        <input type="color" value={value.slice(0, 7) || settings.timelineTint.slice(0, 7) || '#888888'} onChange={(event) => setColor(key, event.target.value)} aria-label={`自定义${label}颜色`} className="size-6 cursor-pointer rounded border border-border bg-transparent p-0" />
                      </span>
                    </div>
                  )
                })}
              </div>
            </details>
          </section>

          {/* ── 尺寸 ── */}
          <section className="flex flex-col gap-4" aria-label="尺寸">
            <h3 className={sectionTitle}>尺寸</h3>
            {SIZE_ITEMS.map(({ key, label, format, step }) => (
              <SettingSlider
                key={key}
                id={`tl-set-${key}`}
                label={label}
                value={settings[key]}
                display={format(settings[key])}
                range={SETTING_RANGES[key]}
                step={step}
                onChange={(v) => setNumeric(key, v)}
              />
            ))}
          </section>

          {/* ── 刻度 ── */}
          <section className="flex flex-col gap-4" aria-label="刻度">
            <h3 className={sectionTitle}>刻度</h3>
            {TICK_ITEMS.map(({ key, label, format }) => (
              <SettingSlider
                key={key}
                id={`tl-set-${key}`}
                label={label}
                value={settings[key]}
                display={format(settings[key])}
                range={SETTING_RANGES[key]}
                onChange={(v) => setNumeric(key, v)}
              />
            ))}
          </section>

          {/* ── 显示与隐藏 ── */}
          <section className="flex flex-col gap-2" aria-label="显示与隐藏">
            <h3 className={sectionTitle}>显示与隐藏</h3>
            <p className="text-xs leading-relaxed text-muted-foreground/60">
              年刻度是时间的骨架,始终显示。
            </p>
            {VISIBILITY_ITEMS.map(({ key, label, hint }) => (
              <label
                key={key}
                className="flex cursor-pointer items-center justify-between rounded-md border border-border px-3 py-2.5 transition-colors hover:border-foreground/30"
              >
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm text-foreground">{label}</span>
                  <span className="text-xs text-muted-foreground/60">{hint}</span>
                </span>
                <input
                  type="checkbox"
                  checked={settings.visibility[key]}
                  onChange={(e) => setVisibility(key, e.target.checked)}
                  className="size-4 accent-primary"
                />
              </label>
            ))}
          </section>

          <section className="flex flex-col gap-2" aria-label="启动体验">
            <h3 className={sectionTitle}>启动体验</h3>
            <p className="text-xs leading-relaxed text-muted-foreground/60">
              用一幅当季线稿迎接打开软件的瞬间，数据准备好后会自动淡出。
            </p>
            <label className="flex cursor-pointer items-center justify-between rounded-md border border-border px-3 py-2.5 transition-colors hover:border-foreground/30">
              <span className="flex flex-col gap-0.5">
                <span className="text-sm text-foreground">显示四季启动画面</span>
                <span className="text-xs text-muted-foreground/60">关闭后下次启动直接进入时间轴</span>
              </span>
              <input
                type="checkbox"
                checked={showSeasonalSplash}
                onChange={(event) => setShowSeasonalSplash(event.target.checked)}
                className="size-4 accent-primary"
              />
            </label>
          </section>

          <section className="flex flex-col gap-2" aria-label="自动调色">
            <h3 className={sectionTitle}>自动调色</h3>
            <p className="text-xs leading-relaxed text-muted-foreground/60">
              当前为{THEME_LABEL[theme]}。到设定时间或达到使用时长后会先提醒，选择「确定」才切换；取消后本次不再提醒。
            </p>
            <label className="flex cursor-pointer items-center justify-between rounded-md border border-border px-3 py-2.5 transition-colors hover:border-foreground/30">
              <span className="flex flex-col gap-0.5">
                <span className="text-sm text-foreground">自动调色</span>
                <span className="text-xs text-muted-foreground/60">统一开启或关闭以下规则；可随时重新开启</span>
              </span>
              <input type="checkbox" checked={automation.enabled} onChange={(event) => setAutomation({ enabled: event.target.checked })} className="size-4 accent-primary" />
            </label>
            <label className="flex cursor-pointer items-center justify-between rounded-md border border-border px-3 py-2.5 transition-colors hover:border-foreground/30">
              <span className="flex flex-col gap-0.5">
                <span className="text-sm text-foreground">按时间切换亮/暗色</span>
                <span className="text-xs text-muted-foreground/60">亮色从日间开始，暗色从夜间开始</span>
              </span>
              <input type="checkbox" disabled={!automation.enabled} checked={automation.scheduleEnabled} onChange={(event) => setAutomation({ scheduleEnabled: event.target.checked })} className="size-4 accent-primary" />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
                亮色开始
                <input type="time" value={minutesToTime(automation.dayStartMinutes)} disabled={!automation.enabled || !automation.scheduleEnabled} onChange={(event) => setAutomation({ dayStartMinutes: timeToMinutes(event.target.value) })} className="rounded-md border border-input bg-background px-2 py-1.5 text-sm text-foreground" />
              </label>
              <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
                暗色开始
                <input type="time" value={minutesToTime(automation.nightStartMinutes)} disabled={!automation.enabled || !automation.scheduleEnabled} onChange={(event) => setAutomation({ nightStartMinutes: timeToMinutes(event.target.value) })} className="rounded-md border border-input bg-background px-2 py-1.5 text-sm text-foreground" />
              </label>
            </div>
            <label className="flex cursor-pointer items-center justify-between rounded-md border border-border px-3 py-2.5 transition-colors hover:border-foreground/30">
              <span className="flex flex-col gap-0.5">
                <span className="text-sm text-foreground">连续使用后自动护眼</span>
                <span className="text-xs text-muted-foreground/60">默认 30 分钟；后台暂停计时，护眼持续到退出软件后恢复原配色</span>
              </span>
              <input type="checkbox" disabled={!automation.enabled} checked={automation.eyeCareEnabled} onChange={(event) => setAutomation({ eyeCareEnabled: event.target.checked })} className="size-4 accent-primary" />
            </label>
            <label className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
              护眼触发时长
              <span className="flex items-center gap-1.5">
                <input type="number" min={MIN_EYECARE_AFTER_MINUTES} max={MAX_EYECARE_AFTER_MINUTES} step={5} value={automation.eyeCareAfterMinutes} disabled={!automation.enabled || !automation.eyeCareEnabled} onChange={(event) => setAutomation({ eyeCareAfterMinutes: Number(event.target.value) })} className="w-20 rounded-md border border-input bg-background px-2 py-1.5 text-right text-sm text-foreground" />
                <span>分钟</span>
              </span>
            </label>
          </section>

          <LocalDataSection />
          <UpdateSettingsSection />
        </div>

        <footer className="flex flex-col border-t border-border/70">
          {/* 撤销提示条 */}
          {showUndo && canUndoReset && (
            <div
              role="status"
              className="flex items-center justify-between border-b border-border/50 bg-muted/50 px-6 py-2.5"
            >
              <span className="text-xs text-muted-foreground">已恢复默认显示设置</span>
              <button
                type="button"
                onClick={() => {
                  undoReset()
                  setShowUndo(false)
                }}
                className="rounded px-2 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted"
              >
                撤销
              </button>
            </div>
          )}
          <div className="flex items-center justify-between px-6 py-4">
            <button
              type="button"
              onClick={handleReset}
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-2 text-sm text-muted-foreground/80 transition-colors hover:bg-muted hover:text-foreground"
            >
              <RotateCcw className="size-3.5" />
              恢复默认
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md bg-primary px-5 py-2 text-sm text-primary-foreground transition-opacity hover:opacity-90"
            >
              完成
            </button>
          </div>
        </footer>
      </div>
    </Overlay>
  )
}

function minutesToTime(minutes: number): string {
  const hours = Math.floor(minutes / 60).toString().padStart(2, '0')
  const rest = (minutes % 60).toString().padStart(2, '0')
  return `${hours}:${rest}`
}

function timeToMinutes(value: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value)
  if (!match) return 0
  return Number(match[1]) * 60 + Number(match[2])
}

/* ── 单条滑杆 ── */
function SettingSlider({
  id,
  label,
  value,
  display,
  range,
  step: customStep,
  onChange,
}: {
  id: string
  label: string
  value: number
  display: string
  range: { min: number; max: number }
  step?: number
  onChange: (v: number) => void
}) {
  const step = customStep ?? (range.max - range.min <= 4 ? 0.5 : range.max - range.min <= 10 ? 1 : (range.max - range.min) / 100)
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <label htmlFor={id} className={fieldLabel}>
          {label}
        </label>
        <span className="font-mono text-xs text-muted-foreground tabular-nums">{display}</span>
      </div>
      <input
        id={id}
        type="range"
        min={range.min}
        max={range.max}
        step={step}
        value={value}
        aria-valuetext={display}
        onChange={(e) => onChange(Number.parseFloat(e.target.value))}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
      />
    </div>
  )
}
