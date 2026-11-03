'use client'

// 正文中的图片块:与段落同级,插在哪里就在哪里,前后都能继续写字。
// 单击选中(出现缩放控制点与小工具),双击或「查看大图」打开预览。

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { Node, NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react'
import { Ellipsis, Expand, ImageOff, Trash2, X } from 'lucide-react'
import { useAttachment } from '@/lib/session-attachments'
import { registerOverlay } from '@/lib/overlay-registry'
import { IMAGE_NODE, normalizeImageLayout, type ImageLayout } from '@/lib/rich-content'
import type { ImageMenuRequest } from './editor-menu'
import { cn } from '@/lib/utils'

/** 独占一行:小 / 中 / 全宽(占正文宽度的百分比);null = 按原始尺寸,但不超过正文宽度 */
const BLOCK_PRESETS = [
  { label: '小', value: 36 },
  { label: '中', value: 64 },
  { label: '全宽', value: 100 },
] as const
/** 文字环绕:图片太宽会把旁边的文字挤成一两个字一行,所以上限更低 */
const WRAP_PRESETS = [
  { label: '小', value: 30 },
  { label: '中', value: 42 },
  { label: '大', value: 55 },
] as const
const WRAP_DEFAULT = 42
const WRAP_MAX = 70
const MIN_WIDTH_PX = 80

/** 切换版式时顺带给出合适的宽度 */
function layoutPatch(from: ImageLayout, to: ImageLayout, width: number | null) {
  if (to.startsWith('wrap')) {
    const keep = from.startsWith('wrap') && width !== null && width <= WRAP_MAX
    return { layout: to, width: keep ? width : WRAP_DEFAULT }
  }
  if (to === 'block') return { layout: to, width: from === 'block' ? width : null }
  // 文外图片的宽度由两侧留白决定,保留原宽度以便移回
  return { layout: to }
}

export interface LifeImageOptions {
  requestMenu: ((request: ImageMenuRequest) => void) | null
}

function dataAttr(name: string, numeric = false) {
  return {
    default: null,
    parseHTML: (el: HTMLElement) => {
      const raw = el.getAttribute(`data-${name}`)
      if (raw === null) return null
      return numeric ? Number(raw) || null : raw
    },
    renderHTML: (attrs: Record<string, unknown>) => {
      const key = name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
      const value = attrs[key]
      return value === null || value === undefined || value === '' ? {} : { [`data-${name}`]: String(value) }
    },
  }
}

export const LifeImage = Node.create<LifeImageOptions>({
  name: IMAGE_NODE,
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addOptions() {
    return { requestMenu: null }
  },

  addAttributes() {
    return {
      layout: {
        default: 'block',
        parseHTML: (el: HTMLElement) => normalizeImageLayout(el.getAttribute('data-layout')),
        renderHTML: (attrs: Record<string, unknown>) =>
          attrs.layout && attrs.layout !== 'block' ? { 'data-layout': String(attrs.layout) } : {},
      },
      attachmentId: dataAttr('attachment-id'),
      name: dataAttr('name'),
      caption: { ...dataAttr('caption'), default: '' },
      width: dataAttr('width', true),
      naturalWidth: dataAttr('natural-width', true),
      naturalHeight: dataAttr('natural-height', true),
    }
  },

  // 只识别本编辑器自己产出的结构;外部粘贴来的 <img>(远程图片)不会被解析
  parseHTML() {
    return [{ tag: 'figure[data-life-image]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['figure', { 'data-life-image': '', ...HTMLAttributes }]
  },

  renderText() {
    return ''
  },

  addNodeView() {
    return ReactNodeViewRenderer(ImageView)
  },
})

function ImageView({
  node,
  selected,
  updateAttributes,
  deleteNode,
  editor,
  extension,
  getPos,
}: ReactNodeViewProps) {
  const attrs = node.attrs as {
    layout: string | null
    attachmentId: string | null
    name: string | null
    caption: string
    width: number | null
    naturalWidth: number | null
    naturalHeight: number | null
  }
  const entry = useAttachment(attrs.attachmentId)
  const [broken, setBroken] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setBroken(false)
  }, [attrs.attachmentId, entry?.url])

  const editable = editor.isEditable
  const alt = attrs.caption || attrs.name || '正文图片'
  const ratio =
    attrs.naturalWidth && attrs.naturalHeight ? `${attrs.naturalWidth} / ${attrs.naturalHeight}` : '4 / 3'

  const layout = normalizeImageLayout(attrs.layout)
  const isWrap = layout === 'wrap-left' || layout === 'wrap-right'
  const isMargin = layout === 'margin-left' || layout === 'margin-right'

  const widthPct = dragWidth ?? attrs.width
  const frameWidth =
    layout !== 'block'
      ? '100%'
      : widthPct
        ? `${widthPct}%`
        : attrs.naturalWidth
          ? `min(100%, ${attrs.naturalWidth}px)`
          : '100%'
  const presets = layout === 'block' ? BLOCK_PRESETS : isWrap ? WRAP_PRESETS : []
  // 独占一行居中,两侧都能拖;环绕只拖朝向文字的那一侧;文外宽度由留白决定
  const handles: ('left' | 'right')[] =
    layout === 'block' ? ['left', 'right'] : layout === 'wrap-left' ? ['right'] : layout === 'wrap-right' ? ['left'] : []

  /* 拖拽缩放:过程中只改本地宽度,松手才写回文档 —— 一次拖动只产生一步撤销。
     独占一行时图片居中,两侧控制点按 2 倍位移换算宽度;环绕时贴边,按 1 倍。 */
  const startResize = (event: ReactPointerEvent<HTMLButtonElement>, side: 'left' | 'right') => {
    const frame = frameRef.current
    if (!frame) return
    event.preventDefault()
    event.stopPropagation()
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)

    const containerWidth = editor.view.dom.getBoundingClientRect().width
    const startWidth = frame.getBoundingClientRect().width
    const startX = event.clientX
    const factor = layout === 'block' ? 2 : 1
    const maxPx = layout === 'block' ? containerWidth : (containerWidth * WRAP_MAX) / 100
    let latest = (startWidth / containerWidth) * 100

    const onMove = (e: PointerEvent) => {
      const dx = (e.clientX - startX) * (side === 'right' ? 1 : -1) * factor
      const px = Math.min(maxPx, Math.max(MIN_WIDTH_PX, startWidth + dx))
      latest = Math.round((px / containerWidth) * 100)
      setDragWidth(latest)
    }
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onUp)
      handle.removeEventListener('pointercancel', onUp)
      setDragWidth(null)
      updateAttributes({ width: latest })
    }
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onUp)
    handle.addEventListener('pointercancel', onUp)
  }

  const showCaption = editable ? selected || attrs.caption !== '' : attrs.caption !== ''
  const unavailable = !entry || entry.status !== 'ready' || broken

  const openMenu = (x: number, y: number) => {
    const request = (extension.options as LifeImageOptions).requestMenu
    if (!request || !editable) return
    const pos = getPos()
    if (typeof pos === 'number') editor.commands.setNodeSelection(pos)
    request({
      kind: 'image',
      x,
      y,
      layout,
      attachmentId: attrs.attachmentId,
      canPreview: !unavailable,
      setLayout: (next) => updateAttributes(layoutPatch(layout, next, attrs.width)),
      preview: () => setPreviewOpen(true),
      remove: () => deleteNode(),
    })
  }

  return (
    <NodeViewWrapper
      ref={wrapperRef}
      className={cn('flex flex-col', layout === 'block' ? 'my-5 items-center' : `lt-img-${layout}`)}
      style={isWrap ? { width: `${widthPct ?? WRAP_DEFAULT}%` } : undefined}
      data-drag-handle=""
      onContextMenu={(e: React.MouseEvent) => {
        if (!editable || e.shiftKey) return
        e.preventDefault()
        e.stopPropagation()
        openMenu(e.clientX, e.clientY)
      }}
    >
      <div
        ref={frameRef}
        data-image-id={attrs.attachmentId ?? undefined}
        data-gallery-id={attrs.attachmentId ?? undefined}
        data-layout={layout}
        className={cn(
          'relative max-w-full rounded-sm transition-shadow',
          selected && editable ? 'ring-2 ring-ring/70 ring-offset-2 ring-offset-background' : '',
        )}
        style={{ width: frameWidth }}
      >
        {unavailable ? (
          <div
            className="flex w-full flex-col items-center justify-center gap-2 rounded-sm border border-dashed border-border bg-muted text-muted-foreground"
            style={{ aspectRatio: ratio }}
            role="img"
            aria-label={`${alt}(无法显示)`}
          >
            <ImageOff className="size-5" aria-hidden="true" />
            <span className="px-4 text-center text-xs leading-relaxed">
              {!entry
                ? '图片已不在本次资料库中'
                : entry.status === 'loading'
                  ? '正在加载图片……'
                  : entry.status === 'error'
                    ? entry.error || '图片资源无法读取'
                    : '这张图片无法显示'}
            </span>
          </div>
        ) : (
          // 使用会话内的对象 URL;真实宽高比预先占位,载入时正文不会跳动
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={entry.url}
            alt={alt}
            draggable={false}
            onError={() => setBroken(true)}
            onDoubleClick={() => setPreviewOpen(true)}
            className="block h-auto w-full rounded-sm"
            style={{ aspectRatio: ratio }}
          />
        )}

        {selected && editable && (
          <>
            <div className="lt-image-tools absolute top-2 right-2 flex items-center gap-0.5 rounded-md border border-border bg-popover/95 p-0.5 text-popover-foreground shadow-sm backdrop-blur-sm">
              {presets.map((preset) => (
                <button
                  key={preset.value}
                  type="button"
                  onClick={() => updateAttributes({ width: preset.value })}
                  aria-pressed={attrs.width === preset.value}
                  className={cn(
                    'rounded px-2 py-1 text-xs transition-colors',
                    attrs.width === preset.value
                      ? 'bg-muted text-foreground'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  {preset.label}
                </button>
              ))}
              {presets.length > 0 && <span className="mx-0.5 h-4 w-px bg-border" aria-hidden="true" />}
              <button
                type="button"
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect()
                  openMenu(r.left, r.bottom + 6)
                }}
                aria-label="图片位置与更多操作"
                aria-haspopup="menu"
                title="位置与更多(也可右键图片)"
                className="flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <Ellipsis className="size-3.5" />
              </button>
              {!unavailable && (
                <button
                  type="button"
                  onClick={() => setPreviewOpen(true)}
                  aria-label="查看大图"
                  title="查看大图"
                  className="flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <Expand className="size-3.5" />
                </button>
              )}
              <button
                type="button"
                onClick={() => deleteNode()}
                aria-label="从正文删除这张图片"
                title="删除(可撤销)"
                className="flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>

            {handles.map((side) => (
              <button
                key={side}
                type="button"
                aria-label={side === 'left' ? '拖动调整图片宽度(左侧)' : '拖动调整图片宽度(右侧)'}
                onPointerDown={(e) => startResize(e, side)}
                className={cn(
                  'absolute bottom-0 size-3.5 translate-y-1/2 cursor-ew-resize touch-none rounded-full border-2 border-background bg-ring',
                  side === 'left' ? 'left-0 -translate-x-1/2' : 'right-0 translate-x-1/2',
                )}
              />
            ))}
          </>
        )}
      </div>

      {showCaption &&
        (editable ? (
          <input
            type="text"
            value={attrs.caption}
            onChange={(e) => updateAttributes({ caption: e.target.value })}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return
              if (e.key === 'Enter' || e.key === 'Escape') {
                e.preventDefault()
                editor.commands.focus()
              }
            }}
            placeholder="添加说明(可选)"
            aria-label="图片说明"
            className="mt-2 w-full max-w-md bg-transparent text-center font-serif text-sm leading-relaxed text-muted-foreground outline-none placeholder:text-muted-foreground/50"
          />
        ) : (
          <p className="mt-2 text-center font-serif text-sm leading-relaxed text-muted-foreground">
            {attrs.caption}
          </p>
        ))}

      {previewOpen && entry && (
        <ImageLightbox
          url={entry.url}
          alt={alt}
          caption={attrs.caption}
          onClose={() => setPreviewOpen(false)}
        />
      )}
    </NodeViewWrapper>
  )
}

/** 大图预览:关闭按钮 / Escape / 点击背景都能关闭,关闭后回到原阅读位置与原焦点 */
function ImageLightbox({
  url,
  alt,
  caption,
  onClose,
}: {
  url: string
  alt: string
  caption: string
  onClose: () => void
}) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    const scrollY = window.scrollY
    const previousFocus = document.activeElement as HTMLElement | null
    const release = registerOverlay()
    document.body.style.overflow = 'hidden'
    closeRef.current?.focus({ preventScroll: true })

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onCloseRef.current()
    }
    document.addEventListener('keydown', onKey, true)

    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.body.style.overflow = ''
      release()
      window.scrollTo({ top: scrollY, behavior: 'instant' })
      previousFocus?.focus?.({ preventScroll: true })
    }
  }, [])

  return createPortal(
    <div
      className="animate-overlay-in fixed inset-0 z-[60] flex flex-col items-center justify-center gap-3 p-6"
      role="dialog"
      aria-modal="true"
      aria-label="图片预览"
    >
      <button
        type="button"
        aria-label="关闭预览"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-zoom-out bg-background/95"
      />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt={alt}
        className="relative max-h-[82vh] max-w-full rounded-sm object-contain shadow-lg"
      />
      {caption && (
        <p className="relative max-w-xl text-center font-serif text-sm leading-relaxed text-muted-foreground">
          {caption}
        </p>
      )}
      <button
        ref={closeRef}
        type="button"
        onClick={onClose}
        aria-label="关闭预览"
        className="absolute top-4 right-4 flex size-10 items-center justify-center rounded-full border border-border bg-background/85 text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <X className="size-4" />
      </button>
    </div>,
    document.body,
  )
}
