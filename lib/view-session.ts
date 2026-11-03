import { isDailyEntry, makeDailyEntry, toDateKey, type LifeEvent } from '@/types/life-event'

export const VIEW_SESSION_KEY = 'life-timeline-view-session-v1'

/** Only durable viewing choices. Dialogs, keyboard and temporary eye care are
 * deliberately not replayed. Diary text/attachments remain in the library. */
export interface ViewSession {
  version: 1
  localDate: string
  selectedId: string | null
  draft: Pick<LifeEvent, 'date' | 'title' | 'importance'> | null
  scrollY: number
  timelineCenter: number | null
  pickedStageId: string | null
  headerCollapsed: boolean
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function validDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T12:00:00`)
  return Number.isFinite(date.getTime()) && toDateKey(date) === value
}

export function normalizeViewSession(value: unknown): ViewSession | null {
  const input = record(value)
  if (!input || input.version !== 1 || !validDay(input.localDate)) return null
  const draft = record(input.draft)
  return {
    version: 1,
    localDate: input.localDate,
    selectedId: typeof input.selectedId === 'string' ? input.selectedId : null,
    draft: draft && validDay(draft.date) ? {
      date: draft.date,
      title: typeof draft.title === 'string' ? draft.title.slice(0, 2000) : makeDailyEntry(draft.date).title,
      importance: typeof draft.importance === 'number' && Number.isFinite(draft.importance) ? Math.max(1, Math.min(5, Math.round(draft.importance))) : 2,
    } : null,
    scrollY: typeof input.scrollY === 'number' && Number.isFinite(input.scrollY) ? Math.max(0, Math.min(10_000_000, input.scrollY)) : 0,
    timelineCenter: typeof input.timelineCenter === 'number' && Number.isFinite(input.timelineCenter) && input.timelineCenter >= 1 && input.timelineCenter < 10000 ? input.timelineCenter : null,
    pickedStageId: typeof input.pickedStageId === 'string' ? input.pickedStageId : null,
    headerCollapsed: input.headerCollapsed === true,
  }
}

export function readBrowserViewSession(): ViewSession | null {
  try { return normalizeViewSession(JSON.parse(localStorage.getItem(VIEW_SESSION_KEY) ?? 'null')) }
  catch { return null }
}

export function resolveViewSession(session: ViewSession | null, events: readonly LifeEvent[], date = new Date()) {
  const today = toDateKey(date)
  const newDay = session !== null && session.localDate !== today
  const selected = newDay
    ? events.find((event) => isDailyEntry(event) && event.date === today)
    : events.find((event) => event.id === session?.selectedId)
  const draft = selected ? null : newDay ? { ...makeDailyEntry(today) } : session?.draft ?? null
  return { selectedId: selected?.id ?? null, draft, newDay, scrollY: newDay ? 0 : session?.scrollY ?? 0 }
}
