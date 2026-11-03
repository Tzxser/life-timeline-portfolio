'use client'

// 时间尺:年 / 月 / 周 / 日 四级刻度(§14-§27)
//
// 上下关系表达的是语义,不是排版偏好:
//
//   主轴【上方】= 具体发生过什么   → 日刻度、Today Cursor、事件刻度与标题
//   主轴【下方】= 时间本身的结构   → 周 / 月 / 年、人生阶段区间
//
//            事件标题 / 日期
//                  │  日刻度(唯一朝上的基础刻度)
//   ━━━━━━━━━━━━━━━┿━━━━━━━━━━━━━━━━  主轴
//                  │  第3周
//                  │
//                  │  8月
//                  │
//                  │  2026
//
// 三级下行刻度长度严格递减(年 > 月 > 周),标签各自贴在自己刻度的末端 ——
// 于是"越粗的粒度越深"自然形成三条互不重叠的标签行(§25-§26),
// 而不需要人工分配行号。所有纵向距离都乘以用户的"宽度"倍率 v(§27)。
//
// 性能:本组件用 React.memo 包裹,月 / 周 / 日只渲染视口 ± overscan 范围内的刻度。
// 传入的 windowStart / windowEnd 已被父级量化(每 240px 才变一次),
// 因此横向拖动时组件极少重渲染,每帧成本与总刻度数量无关(§55)。

import { memo } from 'react'
import type { DayBucket, TimelineGeometry } from '@/lib/timeline-geometry'
import type { TimelineSettings } from '@/lib/timeline-settings'
import { buildRulerLayout } from '@/lib/timeline-ruler-layout'

interface TimelineRulerProps {
  geometry: TimelineGeometry
  settings: TimelineSettings
  /** 纵向视觉倍率(用户"宽度"设置) */
  v: number
  axisY: number
  /** 可见窗口(内容坐标,已量化) */
  windowStart: number
  windowEnd: number
  selectedId: string | null
  /**
   * 今天的内容坐标。今天尚未产生任何日期桶时画一个 Today Cursor(§6);
   * 一旦今天有了真实记录,父级会传 null —— 绝不与真实日刻度重叠出现。
   */
  todayCursorX: number | null
  onDayHover: (bucket: DayBucket | null) => void
  onDayClick: (bucket: DayBucket) => void
}

/* 颜色全部走 CSS 变量,用户自定义时覆盖,否则回落到当前主题默认值(§42) */
const C_YEAR = 'var(--tlc-year, color-mix(in oklab, var(--color-foreground) 32%, transparent))'
const C_MONTH = 'var(--tlc-month, color-mix(in oklab, var(--color-foreground) 24%, transparent))'
const C_WEEK = 'var(--tlc-week, color-mix(in oklab, var(--color-foreground) 18%, transparent))'
const C_DAY = 'var(--tlc-day, color-mix(in oklab, var(--color-foreground) 30%, transparent))'

// Only transforms follow scroll progress. No DOM measurement or React render is
// needed per frame, and the fixed document height cannot feed back into scrollY.
const tickTransform = (expanded: number, compact: number) =>
  `scaleY(calc(1 + ${compact / expanded - 1} * var(--tl-p, 0)))`
const labelTransform = (expanded: number, compact: number) =>
  `translate3d(0, calc(${compact - expanded} * var(--tl-p, 0) * 1px), 0)`

export const TimelineRuler = memo(function TimelineRuler({
  geometry,
  settings,
  v,
  axisY,
  windowStart,
  windowEnd,
  selectedId,
  todayCursorX,
  onDayHover,
  onDayClick,
}: TimelineRulerProps) {
  const { yearSegments, monthTicks, weekTicks, dayBuckets } = geometry
  const tickW = settings.tickStrokeWidth
  const dayH = settings.dayTickHeight * v
  const { expanded, compact, yearLineHeight } = buildRulerLayout(settings)

  const inWindow = (x: number) => x >= windowStart && x <= windowEnd

  return (
    <div className="pointer-events-none absolute inset-0">
      {/* ── 年:全部朝下,四级中最长;所有年份始终存在(§7, §16) */}
      <div aria-hidden="true">
        {yearSegments.map(({ year, x }) => (
          <div key={year}>
            <div
              className="absolute"
              style={{
                left: x, top: axisY, height: expanded.yearHeight, width: tickW, background: C_YEAR,
                transformOrigin: '50% 0', transform: tickTransform(expanded.yearHeight, compact.yearHeight),
              }}
            />
            <span
              className="absolute -translate-x-1/2 font-mono tracking-wider text-muted-foreground/80 tabular-nums"
              data-timeline-year-label={year}
              style={{
                left: x, top: axisY + expanded.yearLabel, fontSize: settings.yearLabelSize,
                lineHeight: `${yearLineHeight}px`, color: 'var(--tlc-year-label)',
                transform: labelTransform(expanded.yearLabel, compact.yearLabel),
              }}
            >
              {year}
            </span>
          </div>
        ))}
      </div>

      {/* ── 月:朝下,比年短;只出现在有内容的月份,标签常驻(§17) */}
      {settings.visibility.months && (
        <div aria-hidden="true" style={{ opacity: 'calc(1 - 1.2 * var(--tl-p))' }}>
          {monthTicks.filter((t) => inWindow(t.x)).map((tick) => (
            <div key={tick.key}>
              <div
                className="absolute"
                style={{
                  left: tick.x,
                  top: axisY,
                  height: expanded.monthHeight,
                  width: tickW,
                  background: C_MONTH,
                  transformOrigin: '50% 0', transform: tickTransform(expanded.monthHeight, compact.monthHeight),
                }}
              />
              <span
                className="absolute -translate-x-1/2 font-mono text-[10px] text-muted-foreground/70 tabular-nums"
                style={{
                  left: tick.x, top: axisY + expanded.monthLabel, color: 'var(--tlc-month-label)',
                  transform: labelTransform(expanded.monthLabel, compact.monthLabel),
                }}
              >
                {tick.label}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* ── 周:朝下,最靠近主轴的一层;只出现在有内容的周(§18) */}
      {settings.visibility.weeks && (
        <div aria-hidden="true" style={{ opacity: 'calc(1 - 1.6 * var(--tl-p))' }}>
          {weekTicks.filter((t) => inWindow(t.x)).map((tick) => (
            <div key={tick.key}>
              <div
                className="absolute"
                style={{
                  left: tick.x,
                  top: axisY,
                  height: expanded.weekHeight,
                  width: tickW,
                  background: C_WEEK,
                  transformOrigin: '50% 0', transform: tickTransform(expanded.weekHeight, compact.weekHeight),
                }}
              />
              <span
                className="absolute -translate-x-1/2 text-[9px] text-muted-foreground/50"
                style={{
                  left: tick.x, top: axisY + expanded.weekLabel, color: 'var(--tlc-week-label)',
                  transform: labelTransform(expanded.weekLabel, compact.weekLabel),
                }}
              >
                {tick.label}
              </span>
            </div>
          ))}
        </div>
      )}

      {/*
        ── 日:唯一朝上的基础刻度(§19-§21)。
        无常驻文字(每天都写日记的人不该被日期数字淹没),Hover 才出卡片。
        一个刻度 = 一个日期桶,可含多条记录。

        领土划分:日刻度桶占据主轴【上方紧贴轴线】的一条浅带,
        事件刻度的热区从这条带的上沿才开始(见 timeline-node 的 dayBandH),
        两者在同一侧却互不抢夺指针 —— 视觉上仍是一根连续的刻度线。
      */}
      {settings.visibility.days && (
        <div style={{ opacity: 'calc(1 - 1.6 * var(--tl-p))' }}>
          {dayBuckets.filter((b) => inWindow(b.x)).map((bucket) => {
            const holdsSelected = bucket.events.some((e) => e.id === selectedId)
            return (
              <button
                key={bucket.key}
                type="button"
                tabIndex={-1}
                className="pointer-events-auto absolute -translate-x-1/2 outline-none"
                style={{ left: bucket.x, top: axisY - dayH - 8, height: dayH + 8, width: 12 }}
                onPointerEnter={() => onDayHover(bucket)}
                onPointerLeave={() => onDayHover(null)}
                onClick={() => onDayClick(bucket)}
                aria-label={`${bucket.year}年${bucket.month}月${bucket.day}日,${bucket.events.length} 条记录`}
              >
                <span
                  className="absolute left-1/2 -translate-x-1/2"
                  style={{
                    bottom: 0,
                    height: dayH,
                    width: holdsSelected ? tickW + 1 : tickW,
                    background: holdsSelected
                      ? 'var(--tlc-selected, var(--color-primary))'
                      : C_DAY,
                  }}
                />
                {/* 同一天有多条记录:刻度顶端一个极小的密度点 */}
                {bucket.events.length > 1 && (
                  <span
                    className="absolute left-1/2 size-[3px] -translate-x-1/2 rounded-full"
                    style={{ bottom: dayH + 2, background: C_DAY }}
                  />
                )}
              </button>
            )
          })}
        </div>
      )}

      {/*
        ── Today Cursor(§6, §29):不是人生记录,只回答"我现在定位在哪里"。
        因此它极其克制:一根虚线 + 一个"今天"小标签,和日刻度同侧同高度语言。
        它活在时间轴内部(而不是 fixed 在页面上),所以进入写作状态时
        跟着主轴一起缩小 / 上移 / compact,不会脱队。
      */}
      {todayCursorX !== null && (
        <div
          aria-hidden="true"
          className="absolute -translate-x-1/2"
          style={{ left: todayCursorX, top: axisY - dayH - 2 - 16 * v, opacity: 'calc(1 - 1.2 * var(--tl-p))' }}
        >
          <span
            className="absolute bottom-0 left-1/2 -translate-x-1/2"
            style={{
              height: dayH + 2 + 16 * v,
              width: tickW,
              background: `repeating-linear-gradient(to bottom, ${C_DAY} 0 2px, transparent 2px 5px)`,
            }}
          />
          <span
            className="absolute bottom-full left-1/2 mb-0.5 -translate-x-1/2 font-mono text-[9px] tracking-wide whitespace-nowrap text-muted-foreground/60"
            style={{ color: 'var(--tlc-today-label)' }}
          >
            今天
          </span>
        </div>
      )}
    </div>
  )
})
