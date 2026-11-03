// 时间几何引擎(Timeline Geometry Engine)
//
// 职责:events + stages 范围 + 显示设置 + 长度缩放
//        ↓
//      年份分段(变宽) / 月分段(变宽) / 月刻度 / 周刻度 / 日期桶 / 事件锚点
//
// React UI 只渲染这里的产物,不做任何几何计算。
//
// 核心设计:
//   · 时间轴是"人生记录空间",不是等距物理时间坐标(§22) ——
//     变宽逻辑递归两级:有内容的年份加宽;年内有密集日记录的月份再加宽。
//     只在年级加宽是不够的:日历比例会把一个日更月压进全年 ~8% 的宽度里,
//     年份加宽被稀释,密集区依旧拥挤。
//   · 密度只看 unique months / weeks / days 的数量,
//     同一天写 10 篇也只算一个日期,不会让年份暴涨(§13)。
//   · 月内定位基于真实日历日比例;年内月份顺序与近似位置仍符合 §21
//     (1 月 1 日靠年头,12 月 20 日靠年尾),只是密集月占比更大。
//   · 整套结果只随 (events, settings, lengthScale) 变化,
//     由调用方 useMemo 缓存 —— scroll / mousemove 永远不会触发重算(§53)。

import type { LifeEvent } from '@/types/life-event'
import type { TimelineSettings } from '@/lib/timeline-settings'

/* ── 日历工具 ─────────────────────────────────────────── */

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

function daysInYear(year: number): number {
  return isLeap(year) ? 366 : 365
}

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

function daysInMonth(year: number, month: number): number {
  return month === 2 && isLeap(year) ? 29 : MONTH_DAYS[month - 1]
}

function daysBeforeMonth(year: number, month: number): number {
  let sum = 0
  for (let m = 1; m < month; m++) sum += MONTH_DAYS[m - 1]
  if (month > 2 && isLeap(year)) sum += 1
  return sum
}

/** 一年内的位置比例 [0,1):基于真实日历天数 */
export function yearFraction(year: number, month: number, day: number): number {
  return (daysBeforeMonth(year, month) + (day - 1)) / daysInYear(year)
}

/** 解析规范化 date 字符串("2016-09-01" / "2016-09" / "2016") */
export function parseEventDate(date: string): { year: number; month: number | null; day: number | null } {
  const [y, m, d] = date.split('-')
  const year = Number.parseInt(y, 10)
  const month = m ? Number.parseInt(m, 10) : null
  const day = d ? Number.parseInt(d, 10) : null
  return { year, month, day }
}

/** 月内第几周(按日期序号分桶:1-7 → 第1周,8-14 → 第2周 …) */
function weekOfMonth(day: number): number {
  return Math.floor((day - 1) / 7) + 1
}

/* ── 输出结构 ─────────────────────────────────────────── */

export interface YearSegment {
  year: number
  x: number
  width: number
  hasContent: boolean
}

export interface MonthTick {
  key: string // '2025-03'
  year: number
  month: number
  x: number
  label: string // '3月'
}

export interface WeekTick {
  key: string // '2025-03-w2'
  year: number
  month: number
  week: number
  x: number
  label: string // '第2周'
}

/** 一个日期桶:同一天的全部记录共享一个日刻度(§20) */
export interface DayBucket {
  key: string // '2025-08-18'
  year: number
  month: number
  day: number
  x: number
  events: LifeEvent[]
  /** 桶内是否包含模糊时间(虚线 / ≈ 表达) */
  fuzzy: boolean
}

export interface EventAnchor {
  event: LifeEvent
  x: number
  /** 模糊时间(approx / stage / unknown)用更淡的虚线刻度表达(§23) */
  fuzzy: boolean
  /** 锚点级别,决定标记与哪级刻度结合 */
  level: 'day' | 'month' | 'year'
}

export interface TimelineGeometry {
  startYear: number
  endYear: number
  edgePad: number
  totalWidth: number
  yearSegments: YearSegment[]
  monthTicks: MonthTick[]
  weekTicks: WeekTick[]
  dayBuckets: DayBucket[]
  eventAnchors: EventAnchor[]
  /** 十进制年份 → 内容 x 坐标(分段线性) */
  yearToX: (decimalYear: number) => number
  /** 内容 x 坐标 → 十进制年份(yearToX 的逆映射,供缩放锚点用) */
  xToYear: (x: number) => number
}

/* ── 密度所需的最小刻度间距(px,100% 长度下) ────────── */
const MONTH_MIN_SPACING = 56
const WEEK_MIN_SPACING = 34
const DAY_MIN_SPACING = 14

/** 月分段:密集月加宽的内部结构(仅有内容的年份持有) */
interface MonthSegment {
  x: number // 相对年份分段起点
  width: number
}

/* ── 主入口 ──────────────────────────────────────────── */

export function buildTimelineGeometry(
  events: LifeEvent[],
  startYear: number,
  endYear: number,
  settings: TimelineSettings,
  lengthScale: number,
  edgePad: number,
): TimelineGeometry {
  const yearCount = Math.max(1, endYear - startYear + 1)

  /* 1. 聚合内容占用:年 → 月 → unique weeks / days(§13) */
  const yearMonths = new Map<number, Set<number>>()
  // key: `${year}-${month}`
  const monthWeeks = new Map<string, Set<number>>()
  const monthDaysSet = new Map<string, Set<number>>()
  const contentYears = new Set<number>()

  for (const event of events) {
    const { year, month, day } = parseEventDate(event.date)
    if (year < startYear || year > endYear) continue
    contentYears.add(year)
    const precise = event.datePrecision === 'day' || event.datePrecision === 'month'
    if (month !== null && precise) {
      if (!yearMonths.has(year)) yearMonths.set(year, new Set())
      yearMonths.get(year)!.add(month)
      if (day !== null && event.datePrecision === 'day') {
        const mKey = `${year}-${month}`
        if (!monthWeeks.has(mKey)) monthWeeks.set(mKey, new Set())
        monthWeeks.get(mKey)!.add(weekOfMonth(day))
        if (!monthDaysSet.has(mKey)) monthDaysSet.set(mKey, new Set())
        monthDaysSet.get(mKey)!.add(day)
      }
    }
  }

  /* 2. 两级变宽:先算每个月需要的宽度,年宽 = 月宽之和(§10-§13, §22)

     无内容年份:整年 = base,内部按日历比例线性。
     有内容年份:12 个月各自成段 ——
       · 无内容月:按日历天数占比分享 base
       · 有内容月:在此基础上保证
           - 月自身 ≥ MONTH_MIN_SPACING(月刻度不挤)
           - 周 ≥ unique weeks × WEEK_MIN_SPACING
           - 日 ≥ 按"记录日的最小真实间隔"推算的每日像素 ——
             这样即便两条记录只隔 2 天,日历比例定位后仍有 DAY_MIN_SPACING
       再乘 (1 + expansionRatio)。 */
  const base = settings.baseYearWidth * lengthScale
  const segments: YearSegment[] = []
  const yearMonthSegs = new Map<number, MonthSegment[]>()
  let cursor = edgePad

  for (let i = 0; i < yearCount; i++) {
    const year = startYear + i
    const months = yearMonths.get(year)
    const hasContent = contentYears.has(year)

    if (!months || months.size === 0) {
      segments.push({ year, x: cursor, width: base, hasContent })
      cursor += base
      continue
    }

    const monthSegs: MonthSegment[] = []
    let mCursor = 0
    for (let m = 1; m <= 12; m++) {
      const dim = daysInMonth(year, m)
      const baseShare = (dim / daysInYear(year)) * base
      let width = baseShare
      if (months.has(m)) {
        const mKey = `${year}-${m}`
        const weeks = monthWeeks.get(mKey)?.size ?? 0
        const days = monthDaysSet.get(mKey)
        let dayRequired = 0
        if (days && days.size > 0) {
          // 记录日之间的最小真实间隔(天),决定月内需要的每日像素
          const sorted = [...days].sort((a, b) => a - b)
          let minGap = dim
          for (let k = 1; k < sorted.length; k++) minGap = Math.min(minGap, sorted[k] - sorted[k - 1])
          if (sorted.length === 1) minGap = dim // 单日不需要撑开
          const perDay = (DAY_MIN_SPACING * lengthScale) / Math.max(1, minGap)
          dayRequired = dim * perDay
        }
        width = Math.max(
          baseShare,
          MONTH_MIN_SPACING * lengthScale,
          weeks * WEEK_MIN_SPACING * lengthScale,
          dayRequired,
        )
        width *= 1 + settings.expansionRatio
      }
      monthSegs.push({ x: mCursor, width })
      mCursor += width
    }

    yearMonthSegs.set(year, monthSegs)
    segments.push({ year, x: cursor, width: mCursor, hasContent })
    cursor += mCursor
  }
  const totalWidth = cursor + edgePad

  /* 3. 日历日期 → x:年分段 → 月分段 → 月内真实日比例(§21) */
  const dateToX = (year: number, month: number, day: number): number => {
    const idx = year - startYear
    if (idx < 0) return segments[0].x + (year + yearFraction(year, month, day) - startYear) * base
    if (idx >= yearCount) {
      const last = segments[yearCount - 1]
      return last.x + last.width + (year + yearFraction(year, month, day) - (endYear + 1)) * base
    }
    const seg = segments[idx]
    const monthSegs = yearMonthSegs.get(year)
    if (!monthSegs) return seg.x + yearFraction(year, month, day) * seg.width
    const ms = monthSegs[month - 1]
    return seg.x + ms.x + ((day - 1) / daysInMonth(year, month)) * ms.width
  }

  /* 4. 十进制年份 ↔ x(经由月分段的分段线性映射,双向单调) */
  const yearToX = (decimalYear: number): number => {
    if (decimalYear <= startYear) return segments[0].x + (decimalYear - startYear) * base
    if (decimalYear >= endYear + 1) {
      const last = segments[yearCount - 1]
      return last.x + last.width + (decimalYear - (endYear + 1)) * base
    }
    const year = Math.floor(decimalYear)
    const frac = decimalYear - year
    const seg = segments[year - startYear]
    const monthSegs = yearMonthSegs.get(year)
    if (!monthSegs) return seg.x + frac * seg.width
    // 年内比例 → 第几天 → 所在月分段内线性
    const dayOfYear = frac * daysInYear(year)
    let m = 1
    let acc = 0
    while (m < 12 && acc + daysInMonth(year, m) <= dayOfYear) {
      acc += daysInMonth(year, m)
      m += 1
    }
    const ms = monthSegs[m - 1]
    return seg.x + ms.x + ((dayOfYear - acc) / daysInMonth(year, m)) * ms.width
  }

  const xToYear = (x: number): number => {
    if (x <= segments[0].x) return startYear + (x - segments[0].x) / base
    const last = segments[yearCount - 1]
    if (x >= last.x + last.width) return endYear + 1 + (x - (last.x + last.width)) / base
    let lo = 0
    let hi = yearCount - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (segments[mid].x <= x) lo = mid
      else hi = mid - 1
    }
    const seg = segments[lo]
    const monthSegs = yearMonthSegs.get(seg.year)
    if (!monthSegs) return seg.year + (x - seg.x) / seg.width
    const rel = x - seg.x
    let m = 11
    for (let k = 1; k < 12; k++) {
      if (monthSegs[k].x > rel) {
        m = k - 1
        break
      }
    }
    const ms = monthSegs[m]
    const dayOfYear =
      daysBeforeMonth(seg.year, m + 1) + ((rel - ms.x) / ms.width) * daysInMonth(seg.year, m + 1)
    return seg.year + dayOfYear / daysInYear(seg.year)
  }

  /* 5. 月 / 周刻度:只出现在有内容的地方(§14, §16) */
  const monthTicks: MonthTick[] = []
  const weekTicks: WeekTick[] = []
  for (const [year, months] of yearMonths) {
    for (const month of [...months].sort((a, b) => a - b)) {
      monthTicks.push({
        key: `${year}-${String(month).padStart(2, '0')}`,
        year,
        month,
        x: dateToX(year, month, 1),
        label: `${month}月`,
      })
      const mKey = `${year}-${month}`
      for (const week of monthWeeks.get(mKey) ?? []) {
        weekTicks.push({
          key: `${year}-${String(month).padStart(2, '0')}-w${week}`,
          year,
          month,
          week,
          x: dateToX(year, month, (week - 1) * 7 + 1),
          label: `第${week}周`,
        })
      }
    }
  }
  monthTicks.sort((a, b) => a.x - b.x)
  weekTicks.sort((a, b) => a.x - b.x)

  /* 6. 日期桶:同一天的记录共享一个日刻度(§18, §20) */
  const bucketMap = new Map<string, DayBucket>()
  for (const event of events) {
    if (event.datePrecision !== 'day') continue
    const { year, month, day } = parseEventDate(event.date)
    if (month === null || day === null) continue
    const key = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    let bucket = bucketMap.get(key)
    if (!bucket) {
      bucket = { key, year, month, day, x: dateToX(year, month, day), events: [], fuzzy: false }
      bucketMap.set(key, bucket)
    }
    bucket.events.push(event)
  }
  const dayBuckets = [...bucketMap.values()].sort((a, b) => a.x - b.x)

  /* 7. 事件锚点:按精度绑定到对应级别的刻度(§23-§24) */
  const eventAnchors: EventAnchor[] = events.map((event) => {
    const { year, month, day } = parseEventDate(event.date)
    const fuzzy =
      event.datePrecision === 'approx' ||
      event.datePrecision === 'stage' ||
      event.datePrecision === 'unknown'
    if (event.datePrecision === 'day' && month !== null && day !== null) {
      return { event, x: dateToX(year, month, day), fuzzy: false, level: 'day' as const }
    }
    if (event.datePrecision === 'month' && month !== null) {
      return { event, x: dateToX(year, month, 1), fuzzy: false, level: 'month' as const }
    }
    // year / approx / stage / unknown:落在估计位置,模糊时间用虚线刻度表达
    const x =
      month !== null
        ? dateToX(year, month, day ?? 15)
        : dateToX(year, 7, 1) // 只有年份:落在年中
    return { event, x, fuzzy, level: event.datePrecision === 'year' ? ('year' as const) : ('month' as const) }
  })

  return {
    startYear,
    endYear,
    edgePad,
    totalWidth,
    yearSegments: segments,
    monthTicks,
    weekTicks,
    dayBuckets,
    eventAnchors,
    yearToX,
    xToYear,
  }
}
