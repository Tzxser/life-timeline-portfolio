'use client'

// 文字 ↔ 图片关联
//
//   · 关联是一个文字标记(imageLink),只记图片的 attachmentId,随正文 JSON 一起保存与撤销。
//   · 图片被删掉时,指向它的标记在同一步里一并移除 —— 撤销删除会把两者一起恢复。
//   · 连线画在正文外层的一张 SVG 上,只走版心两侧的留白,不压住正文;
//     悬停或光标落在关联文字 / 图片上时加深,并用虚线补上从文字末尾到版心边缘的一段。

import { useCallback, useEffect, useRef, useState } from 'react'
import { Mark, type Editor } from '@tiptap/react'
import { NodeSelection, Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'
import { IMAGE_LINK_MARK, IMAGE_NODE } from '@/lib/rich-content'

export interface LinkRange {
  from: number
  to: number
  imageId: string
}

/** 正文里所有关联区间;被加粗等其他标记切开、或跨段落连续的同一关联合并为一段 */
export function collectLinkRanges(doc: PMNode): LinkRange[] {
  const ranges: LinkRange[] = []
  doc.descendants((node, pos) => {
    if (!node.isText) return
    const mark = node.marks.find((m) => m.type.name === IMAGE_LINK_MARK)
    const imageId = mark?.attrs.imageId as string | undefined
    if (!imageId) return
    const last = ranges[ranges.length - 1]
    const end = pos + node.nodeSize
    if (last && last.imageId === imageId && pos - last.to <= 4 && doc.textBetween(last.to, pos) === '') {
      last.to = end
    } else {
      ranges.push({ from: pos, to: end, imageId })
    }
  })
  return ranges
}

export function imageIdsInDoc(doc: PMNode): Set<string> {
  const ids = new Set<string>()
  doc.descendants((node) => {
    if (node.type.name === IMAGE_NODE && typeof node.attrs.attachmentId === 'string') {
      ids.add(node.attrs.attachmentId)
    }
  })
  return ids
}

/** 区间内出现的第一个关联图片 id */
export function linkedImageIn(doc: PMNode, from: number, to: number): string | null {
  return collectLinkRanges(doc).find((r) => r.from < to && r.to > from)?.imageId ?? null
}

export function countLinksTo(doc: PMNode, imageId: string | null): number {
  if (!imageId) return 0
  return collectLinkRanges(doc).filter((r) => r.imageId === imageId).length
}

export function applyLink(editor: Editor, range: { from: number; to: number }, imageId: string) {
  editor
    .chain()
    .focus(undefined, { scrollIntoView: false })
    .setTextSelection(range)
    .setMark(IMAGE_LINK_MARK, { imageId })
    // 收起选区:选中的高亮消失,留下下划线与指向图片的连线
    .setTextSelection(range.to)
    .run()
  flashLink(editor, imageId)
}

/** 取消与 [from, to] 相交的所有关联(整段取消,不会只剩半截) */
export function removeLinksInRange(editor: Editor, range: { from: number; to: number }) {
  const type = editor.schema.marks[IMAGE_LINK_MARK]
  const hits = collectLinkRanges(editor.state.doc).filter((r) => r.from < range.to && r.to > range.from)
  if (!type || hits.length === 0) return
  const tr = editor.state.tr
  hits.forEach((r) => tr.removeMark(r.from, r.to, type))
  editor.view.dispatch(tr)
  editor.commands.focus(undefined, { scrollIntoView: false })
}

export function removeLinksTo(editor: Editor, imageId: string) {
  const type = editor.schema.marks[IMAGE_LINK_MARK]
  const hits = collectLinkRanges(editor.state.doc).filter((r) => r.imageId === imageId)
  if (!type || hits.length === 0) return
  const tr = editor.state.tr
  hits.forEach((r) => tr.removeMark(r.from, r.to, type))
  editor.view.dispatch(tr)
}

export function findImageElement(editor: Editor, imageId: string): HTMLElement | null {
  return editor.view.dom.querySelector<HTMLElement>(`[data-image-id="${CSS.escape(imageId)}"]`)
}

/* ── 高亮状态:放在插件里,文字高亮用装饰实现,不直接改 ProseMirror 管理的 DOM ── */
export const activeLinkKey = new PluginKey<string | null>('imageLinkActive')

export function setActiveLink(editor: Editor | null, imageId: string | null) {
  if (!editor || editor.isDestroyed) return
  if ((activeLinkKey.getState(editor.state) ?? null) === imageId) return
  editor.view.dispatch(editor.state.tr.setMeta(activeLinkKey, imageId).setMeta('addToHistory', false))
}

const flashTimers = new WeakMap<Editor, ReturnType<typeof setTimeout>>()
export function flashLink(editor: Editor, imageId: string, ms = 1600) {
  setActiveLink(editor, imageId)
  const previous = flashTimers.get(editor)
  if (previous) clearTimeout(previous)
  flashTimers.set(
    editor,
    setTimeout(() => {
      if (!editor.isDestroyed && activeLinkKey.getState(editor.state) === imageId) setActiveLink(editor, null)
    }, ms),
  )
}

export const ImageLink = Mark.create({
  name: IMAGE_LINK_MARK,
  // 在关联文字末尾继续输入,新字不会被自动并入关联
  inclusive: false,

  addAttributes() {
    return {
      imageId: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-image-link'),
        renderHTML: (attrs: Record<string, unknown>) =>
          attrs.imageId ? { 'data-image-link': String(attrs.imageId) } : {},
      },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-image-link]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      { ...HTMLAttributes, class: 'lt-image-link', title: '关联了一张图片 · 右键可定位或取消关联' },
      0,
    ]
  },

  addProseMirrorPlugins() {
    const type = this.type
    return [
      new Plugin({
        key: new PluginKey('imageLinkCleanup'),
        // 图片不在了(删除、剪切、粘贴来的外部关联),指向它的关联一并移除
        appendTransaction(transactions, _old, state) {
          if (!transactions.some((tr) => tr.docChanged)) return null
          const ids = imageIdsInDoc(state.doc)
          let tr: ReturnType<typeof state.tr.removeMark> | null = null
          state.doc.descendants((node, pos) => {
            if (!node.isText) return
            node.marks.forEach((mark) => {
              if (mark.type === type && !ids.has(mark.attrs.imageId)) {
                tr ??= state.tr
                tr.removeMark(pos, pos + node.nodeSize, mark)
              }
            })
          })
          return tr
        },
      }),
      new Plugin<string | null>({
        key: activeLinkKey,
        state: {
          init: () => null,
          apply: (tr, value) => {
            const meta = tr.getMeta(activeLinkKey) as string | null | undefined
            return meta === undefined ? value : meta
          },
        },
        props: {
          decorations(state) {
            const id = activeLinkKey.getState(state)
            if (!id) return null
            const decos = collectLinkRanges(state.doc)
              .filter((r) => r.imageId === id)
              .map((r) => Decoration.inline(r.from, r.to, { class: 'lt-link-active' }))
            return DecorationSet.create(state.doc, decos)
          },
        },
      }),
    ]
  },
})

/* ── 连线层 ─────────────────────────────────────────────── */

interface Connector {
  key: string
  imageId: string
  /** 版心边缘 → 图片,始终以浅色显示 */
  main: string
  /** 关联文字末尾 → 版心边缘,仅在高亮时以虚线显示 */
  lead: string
  start: { x: number; y: number }
  end: { x: number; y: number }
}

interface Ring {
  x: number
  y: number
  w: number
  h: number
}

function idFromTarget(target: EventTarget | null, linked: Set<string>): string | null {
  const el = target instanceof Element ? target : null
  if (!el) return null
  const link = el.closest('[data-image-link]')
  if (link) return link.getAttribute('data-image-link')
  const figure = el.closest('[data-image-id]')
  const id = figure?.getAttribute('data-image-id') ?? null
  // 没有任何关联的图片,悬停时不高亮
  return id && linked.has(id) ? id : null
}

export function ImageLinkOverlay({ editor, container }: { editor: Editor | null; container: HTMLElement | null }) {
  const [connectors, setConnectors] = useState<Connector[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [ring, setRing] = useState<Ring | null>(null)
  const linkedIdsRef = useRef(new Set<string>())
  const hoverRef = useRef<string | null>(null)
  const caretRef = useRef<string | null>(null)
  const desiredRef = useRef<string | null>(null)
  const frameRef = useRef(0)

  const compute = useCallback(() => {
    frameRef.current = 0
    if (!editor || editor.isDestroyed || !container) return
    const view = editor.view
    const base = container.getBoundingClientRect()
    const col = view.dom.getBoundingClientRect()
    const colL = col.left - base.left
    const colR = col.right - base.left
    const minX = 6 - base.left
    const maxX = document.documentElement.clientWidth - 6 - base.left
    const clampX = (x: number) => Math.min(maxX, Math.max(minX, x))

    const ranges = collectLinkRanges(view.state.doc)
    linkedIdsRef.current = new Set(ranges.map((r) => r.imageId))
    const next: Connector[] = []

    for (const r of ranges) {
      const figure = findImageElement(editor, r.imageId)
      if (!figure) continue
      const box = figure.getBoundingClientRect()
      const img = {
        l: box.left - base.left,
        r: box.right - base.left,
        t: box.top - base.top,
        b: box.bottom - base.top,
      }
      const side = (figure.dataset.layout ?? 'block').endsWith('left') ? 'left' : 'right'
      const dir = side === 'right' ? 1 : -1
      let anchor
      try {
        anchor = side === 'right' ? view.coordsAtPos(r.to, -1) : view.coordsAtPos(r.from, 1)
      } catch {
        continue
      }
      const ax = (side === 'right' ? anchor.right : anchor.left) - base.left
      const ay = anchor.bottom - base.top + 1
      const edge = clampX(side === 'right' ? colR + 8 : colL - 8)
      const outside = side === 'right' ? img.l >= colR - 1 : img.r <= colL + 1

      let main: string
      let end: { x: number; y: number }
      if (outside) {
        // 文外:从版心边缘平滑地拐到图片的近侧边
        const tx = side === 'right' ? img.l - 6 : img.r + 6
        const ty = Math.min(img.b - 12, Math.max(img.t + 12, ay))
        const mid = (edge + tx) / 2
        main = `M ${edge} ${ay} C ${mid} ${ay} ${mid} ${ty} ${tx} ${ty}`
        end = { x: tx, y: ty }
      } else {
        // 文中:沿留白里的一条“走线”绕行,在图片那一行回到版心,不穿过正文
        const lane = clampX(edge + dir * 26)
        const ty = (img.t + img.b) / 2
        const tx = side === 'right' ? Math.min(img.r + 6, edge) : Math.max(img.l - 6, edge)
        main = `M ${edge} ${ay} C ${lane} ${ay} ${lane} ${ty} ${edge} ${ty} L ${tx} ${ty}`
        end = { x: tx, y: ty }
      }
      next.push({
        key: `${r.imageId}:${r.from}`,
        imageId: r.imageId,
        main,
        lead: `M ${ax} ${ay} L ${edge} ${ay}`,
        start: { x: edge, y: ay },
        end,
      })
    }

    const activeId = activeLinkKey.getState(view.state) ?? null
    const activeFigure = activeId ? findImageElement(editor, activeId) : null
    if (activeFigure) {
      const box = activeFigure.getBoundingClientRect()
      setRing({ x: box.left - base.left - 4, y: box.top - base.top - 4, w: box.width + 8, h: box.height + 8 })
    } else {
      setRing(null)
    }
    setActive(activeId)
    setConnectors(next)
  }, [editor, container])

  const schedule = useCallback(() => {
    if (frameRef.current) return
    frameRef.current = requestAnimationFrame(compute)
  }, [compute])

  const syncActive = useCallback(() => {
    const desired = hoverRef.current ?? caretRef.current
    if (desired === desiredRef.current) return
    desiredRef.current = desired
    setActiveLink(editor, desired)
  }, [editor])

  useEffect(() => {
    if (!editor || !container) return
    const onSelection = () => {
      const { selection } = editor.state
      let id: string | null = null
      if (selection instanceof NodeSelection && selection.node.type.name === IMAGE_NODE) {
        const candidate = selection.node.attrs.attachmentId as string | null
        id = candidate && linkedIdsRef.current.has(candidate) ? candidate : null
      } else if (selection.empty) {
        const mark = selection.$from.marks().find((m) => m.type.name === IMAGE_LINK_MARK)
        id = (mark?.attrs.imageId as string | undefined) ?? null
      }
      caretRef.current = id
      syncActive()
    }
    const onOver = (e: PointerEvent) => {
      hoverRef.current = idFromTarget(e.target, linkedIdsRef.current)
      syncActive()
    }
    const onLeave = () => {
      hoverRef.current = null
      syncActive()
    }

    editor.on('transaction', schedule)
    editor.on('selectionUpdate', onSelection)
    container.addEventListener('pointerover', onOver)
    container.addEventListener('pointerleave', onLeave)
    // 图片载入、字体到位、窗口变化都会改变位置
    container.addEventListener('load', schedule, true)
    window.addEventListener('resize', schedule)
    const observer = new ResizeObserver(schedule)
    observer.observe(container)
    schedule()

    return () => {
      editor.off('transaction', schedule)
      editor.off('selectionUpdate', onSelection)
      container.removeEventListener('pointerover', onOver)
      container.removeEventListener('pointerleave', onLeave)
      container.removeEventListener('load', schedule, true)
      window.removeEventListener('resize', schedule)
      observer.disconnect()
      if (frameRef.current) cancelAnimationFrame(frameRef.current)
      frameRef.current = 0
    }
  }, [editor, container, schedule, syncActive])

  if (connectors.length === 0 && !ring) return null

  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 size-full overflow-visible"
      fill="none"
    >
      {connectors.map((c) => {
        const on = c.imageId === active
        return (
          <g key={c.key} className={on ? 'lt-connector is-active' : 'lt-connector'}>
            {on && <path d={c.lead} strokeDasharray="2 3" />}
            <path d={c.main} />
            <circle cx={c.start.x} cy={c.start.y} r={on ? 2.25 : 1.75} />
            <circle cx={c.end.x} cy={c.end.y} r={on ? 2.25 : 1.75} />
          </g>
        )
      })}
      {ring && (
        <rect
          className="lt-connector-ring"
          x={ring.x}
          y={ring.y}
          width={ring.w}
          height={ring.h}
          rx={4}
        />
      )}
    </svg>
  )
}
