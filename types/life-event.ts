// 人生事件核心类型定义
// 数据层保持抽象,未来可替换为本地文件 / SQLite 等真实数据源

export type DatePrecision =
  | 'day' // 精确日期 2016-09-01
  | 'month' // 月份 2016-09
  | 'year' // 年份 2016
  | 'approx' // 大约时间 ≈2012
  | 'stage' // 只记得人生阶段
  | 'unknown' // 时间未知

export const DATE_PRECISION_LABELS: Record<DatePrecision, string> = {
  day: '精确日期',
  month: '月份',
  year: '年份',
  approx: '大约时间',
  stage: '人生阶段',
  unknown: '时间未知',
}

/**
 * 记录类型(§7)。两者在时间轴上共享同一个日期桶,但语义不同:
 *   event  一个被专门记住的时刻(进入大学 / 第一次比赛),需要先说明"何时发生了什么"
 *   daily  某一天的今日记,不需要先填表格,点「现在」直接开始写
 * 旧数据没有这个字段,一律视为 event —— 因此永远不需要数据迁移。
 */
export type LifeRecordType = 'event' | 'daily'

export interface LifeEvent {
  id: string
  title: string
  /** 缺省 = 'event'。请统一用 recordType() 读取,不要直接判空 */
  type?: LifeRecordType
  /**
   * 用于排序与时间轴定位的规范化时间。
   * 允许 "2016-09-01" / "2016-09" / "2016"。
   * 对于 approx / stage / unknown,这里存放一个估计位置。
   */
  date: string
  /** 用于界面展示的人类可读时间,如 "2016 年 9 月"、"≈ 2012"、"小学三年级左右" */
  displayDate: string
  datePrecision: DatePrecision
  /**
   * 可选的主阶段(引用 LifeStage.id)。
   * 阶段归属主要依据事件时间是否落入阶段区间,因此这里允许为空。
   * 阶段是时间区间与导航上下文,不是事件筛选器:事件始终全部可见。
   */
  stageId: string | null
  /** 重要程度 1~5 */
  importance: number
  summary: string
  /**
   * 纯文本正文。旧记录只有它;有 richContent 时它是从结构化文档派生的纯文本,
   * 供搜索、目录与“是否已写下内容”的判断使用,不再是正文的权威来源。
   */
  content: string
  /** 图文混排正文。存在时是正文唯一的权威来源 */
  richContent?: RichContent
  /** 正文中引用的附件 id,每次编辑时从 richContent 派生,不单独手动维护 */
  attachmentIds?: string[]
}

/** 结构化正文里的一个节点(与 Tiptap / ProseMirror 的 JSON 形态一致) */
export interface RichDocNode {
  type: string
  attrs?: Record<string, unknown>
  content?: RichDocNode[]
  text?: string
  marks?: { type: string; attrs?: Record<string, unknown> }[]
}

export interface RichContent {
  version: 1
  format: 'tiptap-json'
  doc: RichDocNode
}

/**
 * 附件元数据。文件本体(Blob)与临时预览地址不在这里 ——
 * 它们只存在于会话级附件服务中,通过稳定的 id 关联。
 */
export interface AttachmentMeta {
  id: string
  name: string
  mimeType: string
  byteSize: number
  kind: 'image' | 'file'
  width?: number
  height?: number
  lastModified?: number
}

export function recordType(event: Pick<LifeEvent, 'type'>): LifeRecordType {
  return event.type ?? 'event'
}

export function isDailyEntry(event: Pick<LifeEvent, 'type'>): boolean {
  return recordType(event) === 'daily'
}

/** 本地日期 → 规范化 date 字符串。用本地年月日,不经 UTC —— 否则跨时区会错一天 */
export function toDateKey(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** 用户本地的"今天"(§1) */
export function todayKey(): string {
  return toDateKey(new Date())
}

/** "2026-08-19" → "2026 年 8 月 19 日" */
export function formatDayDisplay(dateKey: string): string {
  const [y, m, d] = dateKey.split('-')
  return `${y} 年 ${Number.parseInt(m, 10)} 月 ${Number.parseInt(d, 10)} 日`
}

/**
 * 一篇今日记的初始形态(§33)。
 * 默认按日期命名,与历史日记一致;标题以后仍可随时修改。
 */
export function makeDailyEntry(dateKey: string): Omit<LifeEvent, 'id'> {
  return {
    title: `${dateKey} 日记`,
    type: 'daily',
    date: dateKey,
    displayDate: formatDayDisplay(dateKey),
    datePrecision: 'day',
    stageId: null,
    importance: 2,
    summary: '',
    content: '',
  }
}

/** 将规范化 date 字符串转换为可比较、可定位的十进制年份,如 2016-09 -> 2016.708 */
export function dateToDecimalYear(date: string): number {
  const [y, m = '6', d = '15'] = date.split('-')
  const year = Number.parseInt(y, 10)
  const month = Number.parseInt(m, 10)
  const day = Number.parseInt(d, 10)
  return year + (month - 1) / 12 + (day - 1) / 365
}

export function sortEventsByDate(events: LifeEvent[]): LifeEvent[] {
  return [...events].sort((a, b) => dateToDecimalYear(a.date) - dateToDecimalYear(b.date))
}

/** Body/attachment edits preserve date order; only an actual date change needs sorting. */
export function patchEventInDateOrder(events: LifeEvent[], id: string, patch: Partial<LifeEvent>): LifeEvent[] {
  const index = events.findIndex((event) => event.id === id)
  if (index < 0) return events
  const previous = events[index]
  const next = [...events]
  next[index] = { ...previous, ...patch, id }
  return next[index].date === previous.date ? next : sortEventsByDate(next)
}

/**
 * 目录 / 列表用的紧凑日期:按记录真实拥有的时间精度尽可能完整地显示,绝不虚构精度。
 *   day   → 2009.09.01
 *   month → 2015.09
 *   year  → 2013
 *   approx→ ≈2013;displayDate 里带季节时显示 "2014 · 夏"
 *   stage / unknown → 保留原始语义(如 "时间未定")
 */
export function formatCompactDate(event: LifeEvent): string {
  const [y, m, d] = event.date.split('-')
  switch (event.datePrecision) {
    case 'day':
      return `${y}.${m}.${d}`
    case 'month':
      return `${y}.${m}`
    case 'year':
      return y
    case 'approx': {
      const season = ['春', '夏', '秋', '冬'].find((s) => event.displayDate.includes(s))
      return season ? `${y} · ${season}` : `≈${y}`
    }
    case 'stage':
    case 'unknown':
      return event.displayDate
  }
}
