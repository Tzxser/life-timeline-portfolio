import { uid, validDate, type ScheduleEntry } from './model'

export interface ParsedSchedule { entries: ScheduleEntry[]; warnings: string[]; text: string }
export interface OcrWord { text: string; bbox: { x0: number; y0: number; x1: number; y1: number }; confidence?: number }
export function parseWeeks(value: unknown): number[] | undefined {
  if (Array.isArray(value)) return [...new Set(value.map(Number))].filter(n => Number.isInteger(n) && n >= 1 && n <= 60).sort((a, b) => a - b)
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const text = String(value).replace(/[（）()第周\s]/g, '').replace(/[—–至~～]/g, '-')
  const parity = /单/.test(text) ? 1 : /双/.test(text) ? 0 : undefined
  const result = new Set<number>()
  for (const match of text.matchAll(/(\d{1,2})(?:-(\d{1,2}))?/g)) {
    const a = Number(match[1]), b = Number(match[2] || a)
    for (let n = a; n <= Math.min(b, 60); n++) if (n > 0 && (parity === undefined || n % 2 === parity)) result.add(n)
  }
  return result.size ? [...result].sort((a, b) => a - b) : undefined
}
export function parseWeekday(value: unknown): number | undefined {
  const s = String(value ?? '').trim().toLowerCase()
  const number = Number(s)
  if (/^[1-7]$/.test(s)) return number
  const chinese = s.match(/^(?:星期|礼拜|周)?([一二三四五六日天])$/)
  if (chinese) return chinese[1] === '天' ? 7 : '一二三四五六日'.indexOf(chinese[1]) + 1
  const english = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].findIndex(day => s.startsWith(day))
  return english >= 0 ? english + 1 : undefined
}
export function normalizedDate(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const m = value.match(/^(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})(?:日)?(?:$|\s|T)/)
  if (m) {
    const day = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
    if (validDate(day)) return day
  }
  const english = value.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})\b/i) || value.match(/\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/i)
  if (!english) return undefined
  const months = ['january','february','march','april','may','june','july','august','september','october','november','december']
  const month = months.indexOf((english[1].length > 2 ? english[1] : english[2]).toLowerCase()) + 1
  const dayNumber = Number(english[1].length > 2 ? english[2] : english[1]); const year = Number(english[3])
  const result = `${year}-${String(month).padStart(2, '0')}-${String(dayNumber).padStart(2, '0')}`
  return validDate(result) ? result : undefined
}
const aliases = {
  title: ['title', 'name', 'subject', 'course', 'summary', '课程', '课程名称', '课程名', '事项', '名称', '标题', '活动'],
  date: ['date', 'day', '日期', '具体日期'], weekday: ['weekday', 'dayofweek', '星期', '星期几', '周几'],
  time: ['time', 'period', 'periods', '时间', '节次', '上课时间'], start: ['start', 'starttime', '开始', '开始时间'], end: ['end', 'endtime', '结束', '结束时间'],
  location: ['location', 'room', 'place', '地点', '教室'], notes: ['notes', 'note', 'description', '备注', '说明'],
  teacher: ['teacher', '教师', '任课教师', '老师'], weeks: ['weeks', 'week', '周次', '教学周', '上课周次'],
} as const
const keyOf = (key: string) => key.toLowerCase().replace(/[\s_\-]/g, '')
function field(record: Record<string, unknown>, key: keyof typeof aliases): unknown {
  const found = Object.keys(record).find(k => (aliases[key] as readonly string[]).includes(keyOf(k)))
  return found ? record[found] : undefined
}
const string = (value: unknown) => value === null || value === undefined ? '' : typeof value === 'object' ? '' : String(value).trim()
export function entryFromRecord(record: Record<string, unknown>): ScheduleEntry | null {
  const title = string(field(record, 'title'))
  const date = normalizedDate(field(record, 'date') ?? field(record, 'start'))
  const weekday = parseWeekday(field(record, 'weekday'))
  if (!title || (!date && !weekday)) return null
  const start = string(field(record, 'start')).match(/\d{1,2}:\d{2}/)?.[0] ?? ''
  const end = string(field(record, 'end')).match(/\d{1,2}:\d{2}/)?.[0] ?? ''
  return { id: uid(), title, ...(date ? { date } : { weekday }), weeks: parseWeeks(field(record, 'weeks')), time: string(field(record, 'time')) || [start, end].filter(Boolean).join('–'), location: string(field(record, 'location')), notes: [string(field(record, 'teacher')), string(field(record, 'notes'))].filter(Boolean).join(' · ') }
}
export function parseJson(text: string): ParsedSchedule {
  const value: unknown = JSON.parse(text)
  let list: unknown = value
  for (let depth = 0; depth < 5 && list && typeof list === 'object' && !Array.isArray(list); depth++) {
    const obj = list as Record<string, unknown>
    if (field(obj, 'title')) { list = [obj]; break }
    list = obj.entries ?? obj.events ?? obj.courses ?? obj.schedules ?? obj.data ?? obj.rows
  }
  if (!Array.isArray(list) || list.length > 4000) throw new Error('JSON 需要包含日程对象数组，最多 4000 条。')
  const entries = list.flatMap(record => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return []
    const entry = entryFromRecord(record as Record<string, unknown>)
    return entry ? [entry] : []
  })
  return { entries, warnings: entries.length < list.length ? [`${list.length - entries.length} 条记录缺少明确的日期、星期或事项，请核对原文。`] : [], text }
}
function cellEntries(text: string, weekday: number, time: string): ScheduleEntry[] {
  const chunks = text.trim().split(/\n(?=[A-Za-z0-9]{5,}[_-]\d+)/).filter(Boolean)
  return chunks.map(chunk => {
    const lines = chunk.split('\n').map(line => line.trim()).filter(Boolean)
    const weekMatch = chunk.match(/(?:第)?\d{1,2}(?:\s*[-–—~～至,，、]\s*\d{1,2})*\s*(?:周|[单双]周)(?:[单双])?/)
    const title = (lines[0] || '').replace(/^[A-Za-z0-9]{5,}[_-]\d+\s*/, '').trim()
    return { id: uid(), title, weekday, weeks: parseWeeks(weekMatch?.[0]), time, location: '', notes: lines.slice(1).join(' · ') }
  }).filter(entry => Boolean(entry.title))
}
export function parseMatrix(matrix: unknown[][]): ParsedSchedule {
  const rows = matrix.map(row => row.map(string)).filter(row => row.some(Boolean))
  const text = rows.map(row => row.join('\t')).join('\n')
  if (!rows.length) return { entries: [], warnings: ['文件中没有非空单元格。'], text }
  const isWeekdayHeader = (cell: string) => /(?:星期|礼拜|周|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)/i.test(cell) && parseWeekday(cell) !== undefined
  const headerIndex = rows.slice(0, 15).findIndex(row => row.filter(isWeekdayHeader).length >= 3)
  if (headerIndex >= 0) {
    const headers = rows[headerIndex]
    const entries: ScheduleEntry[] = []
    const warnings: string[] = []
    let previousTime = ''
    for (const row of rows.slice(headerIndex + 1)) {
      const label = row.find((v, i) => !parseWeekday(headers[i]) && /\d/.test(v)) || previousTime
      previousTime = label
      for (let c = 0; c < headers.length; c++) {
        const day = parseWeekday(headers[c])
        if (day && row[c]) {
          entries.push(...cellEntries(row[c], day, label))
          if (!label) warnings.push('部分课程缺少节次，需要在预览中补充。')
        }
      }
    }
    return { entries, warnings: [...new Set(warnings)], text }
  }
  const recordHeader = rows.findIndex(row => row.some(cell => (aliases.title as readonly string[]).includes(keyOf(cell))))
  if (recordHeader >= 0) {
    const header = rows[recordHeader]
    const entries = rows.slice(recordHeader + 1).flatMap(row => { const entry = entryFromRecord(Object.fromEntries(header.map((h, i) => [h, row[i]]))); return entry ? [entry] : [] })
    return { entries, warnings: entries.length < rows.length - recordHeader - 1 ? ['部分行缺少明确的日期、星期或事项，未自动加入。请核对原文。'] : [], text }
  }
  return parseText(text)
}
export function parseText(text: string): ParsedSchedule {
  const trimmed = text.trim()
  if (/^[\[{]/.test(trimmed)) { try { return parseJson(trimmed) } catch { /* Keep the original available for manual review. */ } }
  const lines = trimmed.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const entries: ScheduleEntry[] = []
  let skipped = 0
  for (const line of lines) {
    const dateMatch = line.match(/\d{4}[-/年.]\d{1,2}[-/月.]\d{1,2}日?|\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\b|\b\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\b/i)
    const date = normalizedDate(dateMatch?.[0])
    const dayMatch = line.match(/(?:星期|周|礼拜)[一二三四五六日天]|\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i)
    const day = parseWeekday(dayMatch?.[0])
    if (!date && !day) { skipped++; continue }
    const weekMatch = line.match(/(?:第)?\d{1,2}(?:\s*[-–—~～至,，、]\s*\d{1,2})*\s*[单双]?周/)
    const timeMatch = line.match(/\d{1,2}[:：]\d{2}(?:\s*[-–—~～至]\s*\d{1,2}[:：]\d{2})?|第?\d{1,2}(?:\s*[-–—~～至,，、]\s*\d{1,2})*节/)
    let title = line.replace(dateMatch?.[0] || /$^/, '').replace(dayMatch?.[0] || /$^/, '').replace(weekMatch?.[0] || /$^/, '').replace(timeMatch?.[0] || /$^/, '').replace(/^[\s|,，;；:：\t\-]+|[\s|,，;；]+$/g, '')
    const location = title.match(/(?:地点|教室)\s*[:：]\s*([^;；|]+)/)?.[1]?.trim() || ''
    title = title.replace(/(?:地点|教室)\s*[:：].*/, '').trim()
    if (!title) { skipped++; continue }
    entries.push({ id: uid(), title, ...(date ? { date } : { weekday: day }), weeks: parseWeeks(weekMatch?.[0]), time: (timeMatch?.[0] || '').replace(/：/g, ':'), location, notes: '' })
  }
  return { entries, warnings: skipped ? [`${skipped} 行没有明确的日程信息，保留在原文中供核对。`] : [], text }
}

/** Recover weekday/period relationships from OCR coordinates, not flattened reading order. */
export function parseOcr(words: OcrWord[], text: string, width: number, height: number): ParsedSchedule {
  const lines: OcrWord[][] = []
  for (const word of [...words].filter(w => w.text.trim()).sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0)) {
    const center = (word.bbox.y0 + word.bbox.y1) / 2
    const line = lines.find(group => Math.abs((group[0].bbox.y0 + group[0].bbox.y1) / 2 - center) < Math.max(7, (word.bbox.y1 - word.bbox.y0) * .55))
    if (line) line.push(word); else lines.push([word])
  }
  const joined = (group: OcrWord[]) => [...group].sort((a, b) => a.bbox.x0 - b.bbox.x0).map(w => w.text).join('')
  const header = lines.find(line => [...joined(line).matchAll(/(?:星期|周)[一二三四五六日天]/g)].length >= 3)
  if (!header) return parseText(text)
  header.sort((a, b) => a.bbox.x0 - b.bbox.x0)
  const spans: Array<{ start: number; end: number; word: OcrWord }> = []
  let offset = 0
  for (const word of header) { spans.push({ start: offset, end: offset + word.text.length, word }); offset += word.text.length }
  const centers = [...joined(header).matchAll(/(?:星期|周)([一二三四五六日天])/g)].map(match => {
    const matched = spans.filter(s => s.end > match.index! && s.start < match.index! + match[0].length)
    return { day: parseWeekday(match[0])!, x: (matched[0].word.bbox.x0 + matched.at(-1)!.word.bbox.x1) / 2 }
  })
  const spacing = (centers.at(-1)!.x - centers[0].x) / (centers.at(-1)!.day - centers[0].day)
  if (!(spacing > 20)) return parseText(text)
  const first = centers[0].x - (centers[0].day - 1) * spacing
  const left = first - spacing / 2
  const top = Math.max(...header.map(w => w.bbox.y1))
  const slots = lines.map(line => line.filter(w => w.bbox.x1 < left + 4)).filter(line => line.length && line[0].bbox.y0 > top)
    .map(line => ({ text: joined(line), y: line.reduce((sum, w) => sum + (w.bbox.y0 + w.bbox.y1) / 2, 0) / line.length }))
    .filter(slot => /\d/.test(slot.text) && slot.text.length <= 14)
  if (!slots.length) return { ...parseText(text), warnings: ['识别到星期，但没有可靠识别节次，请在预览中补充或使用 AI。'] }
  const matrix: string[][] = [['节次', ...Array.from({ length: 7 }, (_, i) => `星期${'一二三四五六日'[i]}`)]]
  for (let r = 0; r < slots.length; r++) {
    const y0 = r === 0 ? top : (slots[r - 1].y + slots[r].y) / 2
    const y1 = r === slots.length - 1 ? height : (slots[r].y + slots[r + 1].y) / 2
    const row = [slots[r].text]
    for (let day = 0; day < 7; day++) {
      const x0 = Math.max(0, left + day * spacing), x1 = Math.min(width, x0 + spacing)
      row.push(lines.map(line => line.filter(w => { const x = (w.bbox.x0 + w.bbox.x1) / 2, y = (w.bbox.y0 + w.bbox.y1) / 2; return x >= x0 && x < x1 && y > y0 && y < y1 })).filter(line => line.length).map(joined).join('\n'))
    }
    matrix.push(row)
  }
  const result = parseMatrix(matrix)
  return { ...result, text, warnings: [...result.warnings, '图片已在本机识别。请核对课程文字、周次及跨节次安排。'] }
}
