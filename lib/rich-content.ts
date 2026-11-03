// 图文正文的纯数据工具:只处理 JSON,不依赖编辑器实例,
// 因此搜索、目录、今日记落地判断都可以直接使用。

import type { LifeEvent, RichContent, RichDocNode } from '@/types/life-event'
import { SCHEDULE_NODE, validCard, scheduleText } from '@/lib/schedules/model'

export const IMAGE_NODE = 'lifeImage'
export const ATTACHMENT_NODE = 'lifeAttachment'
/** 文字 → 图片的关联标记;attrs.imageId 指向图片的 attachmentId */
export const IMAGE_LINK_MARK = 'imageLink'

/**
 * 图片版式。
 *   block        文中,独占一行(默认,也是旧数据的取值)
 *   wrap-*       文中,文字环绕,图在左 / 右
 *   margin-*     文外,放在版心左 / 右两侧的留白里;窗口太窄时退化为同侧环绕
 */
export const IMAGE_LAYOUTS = ['block', 'wrap-left', 'wrap-right', 'margin-left', 'margin-right'] as const
export type ImageLayout = (typeof IMAGE_LAYOUTS)[number]

export function normalizeImageLayout(value: unknown): ImageLayout {
  return IMAGE_LAYOUTS.includes(value as ImageLayout) ? (value as ImageLayout) : 'block'
}

export const IMAGE_LAYOUT_LABEL: Record<ImageLayout, string> = {
  block: '文中 · 独占一行',
  'wrap-left': '文中 · 环绕,图在左',
  'wrap-right': '文中 · 环绕,图在右',
  'margin-left': '文外 · 左侧留白',
  'margin-right': '文外 · 右侧留白',
}

/**
 * 旧的纯文本正文 → 结构化文档。
 * 每一行成为一个段落(空行保留为空段落),文字只作为 text 节点写入 ——
 * 原文里的 "<...>" 永远是字面文字,不会被当成 HTML 解析执行。
 */
export function plainTextToDoc(text: string): RichDocNode {
  const lines = text.split(/\r\n|\r|\n/)
  return {
    type: 'doc',
    content: lines.map((line) =>
      line ? { type: 'paragraph', content: [{ type: 'text', text: line }] } : { type: 'paragraph' },
    ),
  }
}

export function docForEvent(event: Pick<LifeEvent, 'richContent' | 'content'>): RichDocNode {
  return event.richContent?.doc ?? plainTextToDoc(event.content)
}

export function toRichContent(doc: RichDocNode): RichContent {
  return { version: 1, format: 'tiptap-json', doc }
}

function walk(node: RichDocNode, visit: (node: RichDocNode) => void) {
  visit(node)
  node.content?.forEach((child) => walk(child, visit))
}

/** 正文按出现顺序引用的附件 id(去重) */
export function collectAttachmentIds(doc: RichDocNode): string[] {
  const ids: string[] = []
  walk(doc, (node) => {
    if (node.type !== IMAGE_NODE && node.type !== ATTACHMENT_NODE) return
    const id = node.attrs?.attachmentId
    if (typeof id === 'string' && !ids.includes(id)) ids.push(id)
  })
  return ids
}

/** 有非空白文字,或至少一张图片 / 一个附件,即为“真正写下了内容” */
export function docHasSubstance(doc: RichDocNode): boolean {
  let found = false
  walk(doc, (node) => {
    if (found) return
    if (node.type === IMAGE_NODE || node.type === ATTACHMENT_NODE || node.type === SCHEDULE_NODE) found = true
    else if (node.type === 'text' && node.text && node.text.trim() !== '') found = true
  })
  return found
}

/** 搜索用的附加文本:图片说明与附件文件名。不含 JSON 结构、地址或二进制内容 */
function docSearchExtras(doc: RichDocNode): string {
  const parts: string[] = []
  walk(doc, (node) => {
    if (node.type === IMAGE_NODE) {
      const caption = node.attrs?.caption
      if (typeof caption === 'string' && caption) parts.push(caption)
    } else if (node.type === SCHEDULE_NODE && validCard(node.attrs?.card)) {
      parts.push(scheduleText(node.attrs.card))
    } else if (node.type === ATTACHMENT_NODE) {
      const name = node.attrs?.name
      if (typeof name === 'string' && name) parts.push(name)
    }
  })
  return parts.join('\n')
}

/** 一条记录全部可搜索的文字(已转小写) */
export function eventSearchText(event: LifeEvent): string {
  const extras = event.richContent ? docSearchExtras(event.richContent.doc) : ''
  return [event.title, event.summary, event.content, extras].join('\n').toLowerCase()
}
