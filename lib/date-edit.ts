import { isDailyEntry, type LifeEvent } from '@/types/life-event'

export type EventDateValue = Pick<LifeEvent, 'date' | 'displayDate' | 'datePrecision'>

export function eventDateValue(event: EventDateValue): EventDateValue {
  return { date: event.date, displayDate: event.displayDate, datePrecision: event.datePrecision }
}

export function hasDateChange(original: EventDateValue, draft: EventDateValue): boolean {
  return original.date !== draft.date
    || original.displayDate !== draft.displayDate
    || original.datePrecision !== draft.datePrecision
}

/** Match the local database's calendar bounds without Date's normalization of invalid days. */
function isCalendarDate(date: string, parts: number): boolean {
  const pattern = parts === 3 ? /^\d{4}-\d{2}-\d{2}$/ : parts === 2 ? /^\d{4}-\d{2}$/ : /^\d{4}$/
  if (!pattern.test(date)) return false
  const [year, month, day] = date.split('-').map(Number)
  if (year < 1 || year > 9999) return false
  if (parts === 1) return true
  if (month < 1 || month > 12) return false
  if (parts === 2) return true
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = month === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31
  return day >= 1 && day <= days
}

export function validateDateEdit(
  event: Pick<LifeEvent, 'id' | 'type'>,
  draft: EventDateValue,
  events: readonly LifeEvent[] = [],
): string | null {
  if (isDailyEntry(event) && draft.datePrecision !== 'day') {
    return '日记需要保留精确日期，请选择具体的一天。'
  }
  const parts = draft.datePrecision === 'day' ? 3 : draft.datePrecision === 'month' ? 2 : 1
  if (!isCalendarDate(draft.date, parts)) {
    return parts === 3 ? '请选择有效的完整日期。' : parts === 2 ? '请输入有效的年月。' : '请输入 0001 至 9999 之间的四位年份。'
  }
  if (!draft.displayDate.trim()) return '请填写时间描述。'
  if (isDailyEntry(event) && events.some((other) => other.id !== event.id && isDailyEntry(other) && other.date === draft.date)) {
    return '这一天已经有一篇日记，请选择其他日期。'
  }
  return null
}

/** User-written titles stay intact; only the exact generated daily title follows its date. */
export function dateEditPatch(event: LifeEvent, draft: EventDateValue): Partial<LifeEvent> {
  const patch: Partial<LifeEvent> = eventDateValue(draft)
  if (isDailyEntry(event) && event.date !== draft.date && event.title === `${event.date} 日记`) {
    patch.title = `${draft.date} 日记`
  }
  return patch
}
