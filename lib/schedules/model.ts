import type { LifeEvent, RichDocNode } from '@/types/life-event'

export const SCHEDULE_NODE = 'lifeSchedule'
export const SCHEDULE_KEY = 'scheduleLibrary'
export const UNDO_KEY = 'scheduleUndo'
export interface ScheduleEntry {
  id: string; title: string; date?: string; weekday?: number; weeks?: number[]
  time: string; location: string; notes: string
}
export interface ScheduleSource {
  id: string; name: string; version: string; updatedAt: string; device: string
  weekOne: string; startDate: string; endDate: string; entries: ScheduleEntry[]
}
export interface GridColumn { id: string; label: string }
export interface GridRow { id: string; cells: Record<string, string> }
export interface GridMerge { rows: string[]; columns: string[] }
export interface ScheduleGrid { columns: GridColumn[]; rows: GridRow[]; merges: GridMerge[] }
export interface ScheduleCard {
  id: string; sourceId: string; sourceName: string; sourceVersion: string
  startDate: string; endDate: string; view: 'list' | 'week'; layout: 'bottom' | 'left' | 'right'
  base: ScheduleGrid; local: ScheduleGrid
}
export interface GridConflict { id: string; label: string; local: string; incoming: string }
export type GridChoices = Record<string, 'local' | 'incoming'>
export interface ScheduleUndo {
  at: string; before: ScheduleSource[]; after: ScheduleSource[]; sourceIds?: string[]
  cardsBefore: Array<{ date: string; index: number; node: RichDocNode }>
  cardIds: string[]; afterCards: RichDocNode[]; afterCardRefs?: Array<{ date: string; index: number; node: RichDocNode }>
}

export const uid = () => crypto.randomUUID()
export const clone = <T,>(value: T): T => structuredClone(value)
export const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
export function dateKey(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
export function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false
  const date = new Date(`${value}T12:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}
const dayNumber = (day: string) => Date.parse(`${day}T12:00:00Z`) / 86400000
export const addDays = (day: string, n: number) => new Date((dayNumber(day) + n) * 86400000).toISOString().slice(0, 10)
export const weekday = (day: string) => new Date(`${day}T12:00:00Z`).getUTCDay() || 7
export const monday = (day: string) => addDays(day, 1 - weekday(day))
export function schoolWeekOne(today: string, currentWeek: number): string {
  if (!validDate(today) || !Number.isInteger(currentWeek) || currentWeek < 1 || currentWeek > 60) throw new Error('请输入 1–60 的当前学校周数。')
  return addDays(monday(today), -(currentWeek - 1) * 7)
}
export function rangeDays(start: string, end: string): string[] {
  if (!validDate(start) || !validDate(end) || end < start || dayNumber(end) - dayNumber(start) > 370) throw new Error('请选择有效日期范围，每张日程最多覆盖 371 天。')
  return Array.from({ length: dayNumber(end) - dayNumber(start) + 1 }, (_, i) => addDays(start, i))
}
export function entriesOn(source: ScheduleSource, day: string): ScheduleEntry[] {
  if (day < source.startDate || day > source.endDate) return []
  const week = Math.floor((dayNumber(day) - dayNumber(source.weekOne)) / 7) + 1
  return source.entries.filter(entry => entry.date ? entry.date === day
    : entry.weekday === weekday(day) && (!entry.weeks?.length || entry.weeks.includes(week)))
    .sort((a, b) => a.time.localeCompare(b.time, 'zh-CN', { numeric: true }))
}
const listColumns: GridColumn[] = [{ id: 'date', label: '日期' }, { id: 'time', label: '时间 / 节次' }, { id: 'title', label: '事项' }, { id: 'location', label: '地点' }, { id: 'notes', label: '备注' }]
export function sourceGrid(source: ScheduleSource, start: string, end: string, view: ScheduleCard['view']): ScheduleGrid {
  const days = rangeDays(start, end)
  if (view === 'week') {
    if (days.length > 7) throw new Error('周课表每张最多显示七天；较长日期段请使用日程列表。')
    const times = [...new Set(days.flatMap(day => entriesOn(source, day).map(entry => entry.time)))].sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }))
    return {
      columns: [{ id: 'time', label: '时间 / 节次' }, ...days.map(day => ({ id: day, label: `${day.slice(5)} 周${'一二三四五六日'[weekday(day) - 1]}` }))],
      rows: times.map(time => ({ id: `time:${time}`, cells: Object.fromEntries([['time', time], ...days.map(day => [day, entriesOn(source, day).filter(entry => entry.time === time).map(entry => [entry.title, entry.location, entry.notes].filter(Boolean).join('\n')).join('\n\n')])]) })), merges: [],
    }
  }
  return { columns: clone(listColumns), rows: days.flatMap(day => entriesOn(source, day).map(entry => ({ id: `${entry.id}@${day}`, cells: { date: day, time: entry.time, title: entry.title, location: entry.location, notes: entry.notes } }))), merges: [] }
}
export function makeCard(source: ScheduleSource, startDate: string, endDate = startDate, view: ScheduleCard['view'] = 'list'): ScheduleCard {
  const base = sourceGrid(source, startDate, endDate, view)
  if (!validateGrid(base)) throw new Error('这段日程内容太多，请缩小日期范围后分次插入。每张最多 4000 行。')
  return { id: uid(), sourceId: source.id, sourceName: source.name, sourceVersion: source.version, startDate, endDate, view, layout: 'bottom', base, local: clone(base) }
}
export function reviseSource(source: ScheduleSource, patch: Partial<ScheduleSource>, device: string): ScheduleSource {
  return { ...clone(source), ...patch, id: source.id, version: uid(), updatedAt: new Date().toISOString(), device }
}

/** Three-way merge by stable row/column identity. Local deletions are edits too. */
export function mergeGrid(base: ScheduleGrid, local: ScheduleGrid, incoming: ScheduleGrid, choices: GridChoices = {}): { grid: ScheduleGrid; conflicts: GridConflict[] } {
  const conflicts: GridConflict[] = []
  const select = <T,>(id: string, label: string, b: T | undefined, l: T | undefined, n: T | undefined): T | undefined => {
    if (equal(l, b)) return cloneOptional(n)
    if (equal(n, b) || equal(l, n)) return cloneOptional(l)
    if (!choices[id]) conflicts.push({ id, label, local: describe(l), incoming: describe(n) })
    return cloneOptional(choices[id] === 'incoming' ? n : l)
  }
  const columns: GridColumn[] = []
  for (const id of orderedIds(local.columns, incoming.columns, base.columns)) {
    const col = select(`column:${id}`, '栏目变化', base.columns.find(c => c.id === id), local.columns.find(c => c.id === id), incoming.columns.find(c => c.id === id))
    if (col) columns.push(col)
  }
  const rows: GridRow[] = []
  for (const id of orderedIds(local.rows, incoming.rows, base.rows)) {
    const b = base.rows.find(r => r.id === id), l = local.rows.find(r => r.id === id), n = incoming.rows.find(r => r.id === id)
    if (!b || !l || !n) {
      const row = select(`row:${id}`, '日程行被新增或删除', b, l, n)
      if (row) rows.push(row)
      continue
    }
    const cells: Record<string, string> = {}
    for (const column of columns) {
      const value = select(`cell:${id}:${column.id}`, `${b.cells.title || b.cells.time || '日程'} · ${column.label}`, b.cells[column.id], l.cells[column.id], n.cells[column.id])
      if (value !== undefined) cells[column.id] = value
    }
    rows.push({ id, cells })
  }
  const merges = clone(local.merges).filter(merge => merge.rows.every(id => rows.some(r => r.id === id)) && merge.columns.every(id => columns.some(c => c.id === id)))
  return { grid: { columns, rows, merges }, conflicts }
}
function cloneOptional<T>(value: T | undefined): T | undefined { return value === undefined ? undefined : clone(value) }
function describe(value: unknown): string {
  if (value === undefined) return '已删除'
  if (typeof value === 'string') return value || '空白'
  const row = value as GridRow
  return row.cells ? Object.values(row.cells).filter(Boolean).join(' · ') : (value as GridColumn).label
}
function orderedIds(...groups: { id: string }[][]): string[] { return [...new Set(groups.flatMap(group => group.map(item => item.id)))] }
export function cardView(card: ScheduleCard, source?: ScheduleSource, choices?: GridChoices) {
  const incoming = source ? sourceGrid(source, card.startDate, card.endDate, card.view) : card.base
  return { ...mergeGrid(card.base, card.local, incoming, choices), incoming }
}
export function rebaseCard(card: ScheduleCard, source: ScheduleSource | undefined, grid: ScheduleGrid): ScheduleCard {
  return { ...card, sourceName: source?.name ?? card.sourceName, sourceVersion: source?.version ?? card.sourceVersion, base: source ? sourceGrid(source, card.startDate, card.endDate, card.view) : card.base, local: grid }
}
export function cardNodes(events: LifeEvent[]): Array<{ date: string; index: number; node: RichDocNode }> {
  return events.flatMap(event => (event.richContent?.doc.content ?? []).flatMap((node, index) => node.type === SCHEDULE_NODE ? [{ date: event.date, index, node }] : []))
}
export function scheduleText(card: ScheduleCard): string {
  return `${card.sourceName}\n${card.local.rows.map(row => card.local.columns.map(col => row.cells[col.id] || '').join(' ')).join('\n')}`
}

/** An explicit, bounded local data contract; AI and imported JSON use the same check. */
export function validateSource(value: unknown): ScheduleSource {
  if (!value || typeof value !== 'object') throw new Error('日程数据格式不正确。')
  const s = value as ScheduleSource
  if (![s.id, s.name, s.version, s.updatedAt, s.device].every(v => typeof v === 'string' && v.length > 0 && v.length <= 300)) throw new Error('日程名称或版本信息不完整。')
  rangeDays(s.startDate, s.endDate)
  if (!validDate(s.weekOne) || weekday(s.weekOne) !== 1 || !Array.isArray(s.entries) || s.entries.length > 4000) throw new Error('请检查第一周日期与日程条目数量。')
  const ids = new Set<string>()
  for (const e of s.entries) {
    if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !e.id || e.id.length > 150 || ids.has(e.id)) throw new Error('日程条目标识无效或重复。')
    ids.add(e.id)
    if (!e.title?.trim() || ![e.title, e.time, e.location, e.notes].every(v => typeof v === 'string' && v.length <= 4000)) throw new Error('请填写事项，并检查时间、地点和备注。')
    if (e.date ? !validDate(e.date) : !Number.isInteger(e.weekday) || e.weekday! < 1 || e.weekday! > 7) throw new Error('每条日程需要日期或星期。')
    if (e.weeks && (!Array.isArray(e.weeks) || e.weeks.length > 60 || e.weeks.some(w => !Number.isInteger(w) || w < 1 || w > 60))) throw new Error('周次应在 1–60 之间。')
  }
  return clone(s)
}
export function validateGrid(value: unknown): value is ScheduleGrid {
  if (!value || typeof value !== 'object') return false
  const g = value as ScheduleGrid
  const key = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length < 200 && !['__proto__', 'constructor', 'prototype'].includes(v)
  if (!Array.isArray(g.columns) || !Array.isArray(g.rows) || !Array.isArray(g.merges) || g.columns.length > 64 || g.rows.length > 4000 || g.merges.length > 4000) return false
  if (new Set(g.columns.map(c => c?.id)).size !== g.columns.length || new Set(g.rows.map(r => r?.id)).size !== g.rows.length) return false
  return g.columns.every(c => c && key(c.id) && typeof c.label === 'string' && c.label.length < 1000)
    && g.rows.every(r => r && key(r.id) && r.cells && typeof r.cells === 'object' && !Array.isArray(r.cells) && Object.entries(r.cells).every(([k, v]) => key(k) && typeof v === 'string' && v.length <= 8000))
    && g.merges.every(m => m && Array.isArray(m.rows) && Array.isArray(m.columns) && m.rows.length > 0 && m.columns.length > 0 && m.rows.every(id => g.rows.some(r => r.id === id)) && m.columns.every(id => g.columns.some(c => c.id === id)))
}
export function validCard(value: unknown): value is ScheduleCard {
  if (!value || typeof value !== 'object') return false
  const c = value as ScheduleCard
  return [c.id, c.sourceId, c.sourceName, c.sourceVersion].every(v => typeof v === 'string' && v.length > 0 && v.length <= 300)
    && validDate(c.startDate) && validDate(c.endDate) && c.endDate >= c.startDate && dayNumber(c.endDate) - dayNumber(c.startDate) <= 370
    && ['list', 'week'].includes(c.view) && (c.view !== 'week' || dayNumber(c.endDate) - dayNumber(c.startDate) < 7)
    && ['bottom', 'left', 'right'].includes(c.layout) && validateGrid(c.base) && validateGrid(c.local)
}
