// 图集的数据来源:直接从每篇记录的正文里派生,不单独维护一份清单。
// 于是“插入即登记、删除即消失、撤销即回来”都是自动的,永远不会与原文不同步。
//
// 收录范围:正文中的图片节点,以及 mimeType 为 video/* 或 audio/* 的附件。
// 归档时间取所在记录的时间(而不是文件拍摄时间)—— 图集是人生记录的另一种读法。

import type { LifeEvent, RichDocNode } from '@/types/life-event'
import { formatCompactDate } from '@/types/life-event'
import { ATTACHMENT_NODE, IMAGE_NODE } from './rich-content'
import { getAttachment } from './session-attachments'

export type MediaKind = 'image' | 'video' | 'audio'

export const MEDIA_KIND_LABEL: Record<MediaKind, string> = {
  image: '图片',
  video: '视频',
  audio: '音频',
}

export interface GalleryItem {
  /** 同一附件可能被粘贴进多篇记录,所以 key 同时带上记录 id 与出现序号 */
  key: string
  kind: MediaKind
  attachmentId: string
  url: string
  name: string
  caption: string
  width: number | null
  height: number | null
  eventId: string
  eventTitle: string
  eventDate: string
  compactDate: string
  /** 在原文中的出现顺序 */
  order: number
}

export interface GalleryMonth {
  key: string
  label: string
  items: GalleryItem[]
}

export interface GalleryYear {
  year: string
  count: number
  months: GalleryMonth[]
}

function mediaKindOf(node: RichDocNode): MediaKind | null {
  if (node.type === IMAGE_NODE) return 'image'
  if (node.type !== ATTACHMENT_NODE) return null
  const mime = typeof node.attrs?.mimeType === 'string' ? node.attrs.mimeType : ''
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  return null
}

function collectFromDoc(doc: RichDocNode, visit: (node: RichDocNode, kind: MediaKind) => void) {
  const stack: RichDocNode[] = [doc]
  const ordered: RichDocNode[] = []
  // 深度优先、保持文档顺序
  while (stack.length) {
    const node = stack.shift() as RichDocNode
    ordered.push(node)
    if (node.content) stack.unshift(...node.content)
  }
  for (const node of ordered) {
    const kind = mediaKindOf(node)
    if (kind) visit(node, kind)
  }
}

/** 全部记录中仍可显示的图片 / 视频 / 音频。本次会话里已不存在的文件不收录 */
export function collectGalleryItems(events: LifeEvent[]): GalleryItem[] {
  const items: GalleryItem[] = []
  for (const event of events) {
    const doc = event.richContent?.doc
    if (!doc) continue
    let order = 0
    collectFromDoc(doc, (node, kind) => {
      const id = node.attrs?.attachmentId
      const entry = getAttachment(id)
      if (!entry || entry.status !== 'ready' || !entry.url || typeof id !== 'string') return
      const attrs = node.attrs ?? {}
      items.push({
        key: `${event.id}:${order}:${id}`,
        kind,
        attachmentId: id,
        url: entry.url,
        name: entry.meta.name,
        caption: typeof attrs.caption === 'string' ? attrs.caption : '',
        width: entry.meta.width ?? (typeof attrs.naturalWidth === 'number' ? attrs.naturalWidth : null),
        height: entry.meta.height ?? (typeof attrs.naturalHeight === 'number' ? attrs.naturalHeight : null),
        eventId: event.id,
        eventTitle: event.title || '未命名记录',
        eventDate: event.date,
        compactDate: formatCompactDate(event),
        order: order++,
      })
    })
  }
  return items
}

/** 按 年 → 月 分组,新的在前;同一个月内按记录时间倒序、同篇内按原文顺序 */
export function groupByYearMonth(items: GalleryItem[]): GalleryYear[] {
  const sorted = [...items].sort((a, b) => {
    if (a.eventDate !== b.eventDate) return a.eventDate < b.eventDate ? 1 : -1
    if (a.eventId !== b.eventId) return a.eventId < b.eventId ? 1 : -1
    return a.order - b.order
  })

  const years: GalleryYear[] = []
  for (const item of sorted) {
    const [y, m] = item.eventDate.split('-')
    const year = y || '时间未定'
    const monthNum = m ? Number.parseInt(m, 10) : 0
    const monthKey = `${year}-${String(monthNum).padStart(2, '0')}`

    let yearGroup = years[years.length - 1]
    if (!yearGroup || yearGroup.year !== year) {
      yearGroup = { year, count: 0, months: [] }
      years.push(yearGroup)
    }
    let monthGroup = yearGroup.months[yearGroup.months.length - 1]
    if (!monthGroup || monthGroup.key !== monthKey) {
      monthGroup = { key: monthKey, label: monthNum ? `${monthNum} 月` : '月份未定', items: [] }
      yearGroup.months.push(monthGroup)
    }
    monthGroup.items.push(item)
    yearGroup.count++
  }
  return years
}

export function countByKind(items: GalleryItem[]): Record<MediaKind, number> {
  const counts: Record<MediaKind, number> = { image: 0, video: 0, audio: 0 }
  for (const item of items) counts[item.kind]++
  return counts
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}
