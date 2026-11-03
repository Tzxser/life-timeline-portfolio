import type { LifeEvent, RichDocNode } from '@/types/life-event'
import { cardNodes, clone, equal, SCHEDULE_NODE, type ScheduleSource, type ScheduleUndo } from './model'

export function makeScheduleUndo(before: ScheduleSource[], after: ScheduleSource[], events: LifeEvent[] = [], afterEvents: LifeEvent[] = events): ScheduleUndo {
  const sourceIds = [...new Set([...before, ...after].map(s => s.id))]
  const cardsBefore = cardNodes(events).filter(c => sourceIds.includes(String((c.node.attrs?.card as { sourceId?: string })?.sourceId)))
  const cardsAfter = cardNodes(afterEvents).filter(c => sourceIds.includes(String((c.node.attrs?.card as { sourceId?: string })?.sourceId)))
  const cardIds = [...new Set([...cardsBefore, ...cardsAfter].map(c => String((c.node.attrs?.card as { id?: string })?.id)))]
  return { at: new Date().toISOString(), before: clone(before), after: clone(after), sourceIds, cardsBefore: clone(cardsBefore), cardIds, afterCards: cardsAfter.map(c => clone(c.node)), afterCardRefs: clone(cardsAfter) }
}
export function undoHasLaterChanges(undo: ScheduleUndo, sources: ScheduleSource[], events: LifeEvent[]): boolean {
  const ids = new Set(undo.sourceIds ?? [...undo.before, ...undo.after].map(s => s.id))
  const current = sources.filter(s => ids.has(s.id)).sort((a, b) => a.id.localeCompare(b.id))
  const after = [...undo.after].sort((a, b) => a.id.localeCompare(b.id))
  const cards = cardNodes(events).filter(c => ids.has(String((c.node.attrs?.card as { sourceId?: string })?.sourceId)) || undo.cardIds.includes(String((c.node.attrs?.card as { id?: string })?.id)))
  const cardsMatch = undo.afterCardRefs ? equal(cards, undo.afterCardRefs) : equal(cards.map(card => card.node), undo.afterCards)
  return !equal(current, after) || !cardsMatch
}
export function rollbackSchedules(undo: ScheduleUndo, sources: ScheduleSource[], events: LifeEvent[]) {
  const affected = new Set(undo.sourceIds ?? [...undo.before, ...undo.after].map(s => s.id))
  const beforeById = new Map(undo.before.map(source => [source.id, source]))
  const present = new Set<string>()
  const schedules = sources.flatMap(source => {
    if (!affected.has(source.id)) return [source]
    const restored = beforeById.get(source.id)
    if (!restored) return []
    present.add(source.id)
    return [clone(restored)]
  })
  for (const restored of undo.before) if (!present.has(restored.id) && !sources.some(source => source.id === restored.id)) schedules.push(clone(restored))
  const nextEvents = events.map(event => {
    const content = event.richContent?.doc.content
    if (!content) return event
    const remove = (node: RichDocNode) => node.type === SCHEDULE_NODE && (affected.has(String((node.attrs?.card as { sourceId?: string })?.sourceId)) || undo.cardIds.includes(String((node.attrs?.card as { id?: string })?.id)))
    const before = undo.cardsBefore.filter(c => c.date === event.date)
    if (!content.some(remove) && !before.length) return event
    const next = content.filter(node => !remove(node)).map(clone)
    for (const item of [...before].sort((a, b) => a.index - b.index)) next.splice(Math.min(item.index, next.length), 0, clone(item.node))
    // Normal text, images and attachments are untouched, including edits made
    // after the transfer. Only the selected schedule nodes are restored.
    return { ...event, richContent: { ...event.richContent!, doc: { ...event.richContent!.doc, content: next } } }
  })
  return { schedules, events: nextEvents }
}
