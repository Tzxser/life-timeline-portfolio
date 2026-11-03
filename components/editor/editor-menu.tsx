'use client'

// 正文右键菜单:图片版式 / 文字关联图片。
// 只在图片上、或选中文字 / 已关联文字上接管右键;按住 Shift 右键仍是浏览器自带菜单。

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import type { Editor } from '@tiptap/react'
import { Check, ChevronLeft, Copy, Expand, Link2, Link2Off, LocateFixed, Trash2 } from 'lucide-react'
import {
  IMAGE_LAYOUT_LABEL,
  IMAGE_NODE,
  normalizeImageLayout,
  type ImageLayout,
} from '@/lib/rich-content'
import { useAttachment } from '@/lib/session-attachments'
import { registerOverlay } from '@/lib/overlay-registry'
import {
  applyLink,
  countLinksTo,
  findImageElement,
  flashLink,
  linkedImageIn,
  removeLinksInRange,
  removeLinksTo,
  setActiveLink,
} from './image-links'
import { cn } from '@/lib/utils'

export interface ImageMenuRequest {
  kind: 'image'
  x: number
  y: number
  layout: ImageLayout
  attachmentId: string | null
  canPreview: boolean
  setLayout: (layout: ImageLayout) => void
  preview: () => void
  remove: () => void
}

export interface TextMenuRequest {
  kind: 'text'
  x: number
  y: number
  range: { from: number; to: number }
  /** 从工具栏打开时直接进入选图 */
  startInPicker?: boolean
}

export type MenuRequest = ImageMenuRequest | TextMenuRequest

/** 与 globals.css 中文外图片的断点一致 */
const MARGIN_QUERY = '(min-width: 75rem)'

function useMarginAvailable() {
  return useSyncExternalStore(
    (notify) => {
      const mql = window.matchMedia(MARGIN_QUERY)
      mql.addEventListener('change', notify)
      return () => mql.removeEventListener('change', notify)
    },
    () => window.matchMedia(MARGIN_QUERY).matches,
    () => true,
  )
}

interface DocImage {
  attachmentId: string
  label: string
  layout: ImageLayout
}

function imagesInDoc(editor: Editor): DocImage[] {
  const list: DocImage[] = []
  const seen = new Set<string>()
  editor.state.doc.descendants((node) => {
    if (node.type.name !== IMAGE_NODE) return
    const id = node.attrs.attachmentId as string | null
    if (!id || seen.has(id)) return
    seen.add(id)
    list.push({
      attachmentId: id,
      label: (node.attrs.caption as string) || (node.attrs.name as string) || '未命名图片',
      layout: normalizeImageLayout(node.attrs.layout),
    })
  })
  return list
}

export function EditorMenu({
  editor,
  request,
  onClose,
}: {
  editor: Editor
  request: MenuRequest
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<'main' | 'pick'>(
    request.kind === 'text' && request.startInPicker ? 'pick' : 'main',
  )
  const [position, setPosition] = useState({ left: request.x, top: request.y })
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  /* 贴着鼠标打开,但不越出视口 */
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    const left = Math.max(8, Math.min(request.x, window.innerWidth - width - 8))
    const top =
      request.y + height > window.innerHeight - 8 ? Math.max(8, request.y - height) : request.y
    setPosition({ left, top })
  }, [request, view])

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])')?.focus({
      preventScroll: true,
    })
  }, [view])

  useEffect(() => {
    const release = registerOverlay()
    const inside = (target: EventTarget | null) =>
      target instanceof Node && ref.current?.contains(target)
    const onPointerDown = (e: PointerEvent) => {
      if (!inside(e.target)) onCloseRef.current()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onCloseRef.current()
    }
    const onScroll = (e: Event) => {
      if (!inside(e.target)) onCloseRef.current()
    }
    const close = () => onCloseRef.current()
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
      release()
    }
  }, [])

  const onMenuKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(
      ref.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])') ?? [],
    )
    if (items.length === 0) return
    const index = items.indexOf(document.activeElement as HTMLElement)
    let next = -1
    if (e.key === 'ArrowDown') next = (index + 1) % items.length
    else if (e.key === 'ArrowUp') next = (index - 1 + items.length) % items.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = items.length - 1
    else if (e.key === 'Tab') {
      e.preventDefault()
      onCloseRef.current()
      return
    }
    if (next === -1) return
    e.preventDefault()
    items[next].focus()
  }

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={request.kind === 'image' ? '图片' : '文字'}
      onKeyDown={onMenuKeyDown}
      onContextMenu={(e) => e.preventDefault()}
      className="animate-overlay-in fixed z-[70] flex w-64 flex-col rounded-lg border border-border bg-popover p-1 text-sm text-popover-foreground shadow-lg"
      style={position}
    >
      {request.kind === 'image' ? (
        <ImageMenu editor={editor} request={request} onClose={onClose} />
      ) : view === 'pick' ? (
        <ImagePicker
          editor={editor}
          request={request}
          onBack={request.startInPicker ? undefined : () => setView('main')}
          onClose={onClose}
        />
      ) : (
        <TextMenu editor={editor} request={request} onPick={() => setView('pick')} onClose={onClose} />
      )}
    </div>,
    document.body,
  )
}

/* ── 图片菜单 ─────────────────────────────────────────── */

function ImageMenu({
  editor,
  request,
  onClose,
}: {
  editor: Editor
  request: ImageMenuRequest
  onClose: () => void
}) {
  const marginAvailable = useMarginAvailable()
  const inMargin = request.layout.startsWith('margin')
  const linkCount = countLinksTo(editor.state.doc, request.attachmentId)

  const choose = (layout: ImageLayout) => {
    if (layout !== request.layout) request.setLayout(layout)
    onClose()
  }

  const layoutItem = (layout: ImageLayout, label: string) => (
    <MenuItem
      key={layout}
      role="menuitemradio"
      checked={request.layout === layout}
      icon={<LayoutGlyph layout={layout} />}
      onSelect={() => choose(layout)}
    >
      {label}
    </MenuItem>
  )

  return (
    <>
      <MenuLabel>{inMargin ? '移回文中' : '文中'}</MenuLabel>
      {layoutItem('block', '独占一行')}
      {layoutItem('wrap-left', '文字环绕 · 图在左')}
      {layoutItem('wrap-right', '文字环绕 · 图在右')}
      <MenuLabel>文外</MenuLabel>
      {layoutItem('margin-left', '放到左侧留白')}
      {layoutItem('margin-right', '放到右侧留白')}
      {!marginAvailable && (
        <p className="px-2 pt-0.5 pb-1 text-xs leading-relaxed text-muted-foreground">
          当前窗口两侧留白不足,文外图片会暂以环绕方式显示。
        </p>
      )}
      <MenuSeparator />
      {request.canPreview && (
        <MenuItem
          icon={<Expand className="size-4" />}
          onSelect={() => {
            onClose()
            request.preview()
          }}
        >
          查看大图
        </MenuItem>
      )}
      {linkCount > 0 && request.attachmentId && (
        <MenuItem
          icon={<Link2Off className="size-4" />}
          onSelect={() => {
            removeLinksTo(editor, request.attachmentId as string)
            onClose()
          }}
        >
          {`取消 ${linkCount} 处文字关联`}
        </MenuItem>
      )}
      <MenuItem
        icon={<Trash2 className="size-4" />}
        tone="destructive"
        onSelect={() => {
          onClose()
          request.remove()
        }}
      >
        删除图片
      </MenuItem>
    </>
  )
}

/* ── 文字菜单 ─────────────────────────────────────────── */

function TextMenu({
  editor,
  request,
  onPick,
  onClose,
}: {
  editor: Editor
  request: TextMenuRequest
  onPick: () => void
  onClose: () => void
}) {
  const { from, to } = request.range
  const linkedId = linkedImageIn(editor.state.doc, from, to)
  const hasImages = imagesInDoc(editor).length > 0

  const copy = () => {
    editor.chain().focus(undefined, { scrollIntoView: false }).setTextSelection(request.range).run()
    document.execCommand('copy')
    onClose()
  }

  return (
    <>
      {linkedId ? (
        <>
          <LinkedPreview imageId={linkedId} editor={editor} />
          <MenuItem
            icon={<LocateFixed className="size-4" />}
            onSelect={() => {
              onClose()
              findImageElement(editor, linkedId)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
              flashLink(editor, linkedId, 2200)
            }}
          >
            定位关联图片
          </MenuItem>
          <MenuItem icon={<Link2 className="size-4" />} onSelect={onPick}>
            更换关联图片…
          </MenuItem>
          <MenuItem
            icon={<Link2Off className="size-4" />}
            onSelect={() => {
              removeLinksInRange(editor, request.range)
              onClose()
            }}
          >
            取消关联
          </MenuItem>
        </>
      ) : (
        <MenuItem icon={<Link2 className="size-4" />} disabled={!hasImages} onSelect={onPick}>
          关联图片…
        </MenuItem>
      )}
      {!hasImages && !linkedId && (
        <p className="px-2 pb-1 text-xs leading-relaxed text-muted-foreground">
          这篇记录里还没有图片,先插入一张再来关联。
        </p>
      )}
      <MenuSeparator />
      <MenuItem icon={<Copy className="size-4" />} onSelect={copy}>
        复制
      </MenuItem>
      <p className="px-2 pt-1 pb-0.5 text-xs text-muted-foreground/80">按住 Shift 右键可打开浏览器菜单</p>
    </>
  )
}

function LinkedPreview({ editor, imageId }: { editor: Editor; imageId: string }) {
  const image = imagesInDoc(editor).find((img) => img.attachmentId === imageId)
  if (!image) return null
  return (
    <div className="flex items-center gap-2.5 px-2 pt-1.5 pb-2">
      <Thumb imageId={imageId} />
      <div className="flex min-w-0 flex-col">
        <span className="text-xs text-muted-foreground">已关联</span>
        <span className="truncate text-sm">{image.label}</span>
      </div>
    </div>
  )
}

/* ── 选图 ─────────────────────────────────────────────── */

function ImagePicker({
  editor,
  request,
  onBack,
  onClose,
}: {
  editor: Editor
  request: TextMenuRequest
  onBack?: () => void
  onClose: () => void
}) {
  const images = imagesInDoc(editor)
  const current = linkedImageIn(editor.state.doc, request.range.from, request.range.to)

  // 离开选图时撤掉预览高亮;已确认关联时保留,由关联后的短暂高亮接管
  const appliedRef = useRef(false)
  useEffect(
    () => () => {
      if (!appliedRef.current) setActiveLink(editor, null)
    },
    [editor],
  )

  return (
    <>
      <div className="flex items-center gap-1 px-1 pt-0.5 pb-1">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            aria-label="返回"
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ChevronLeft className="size-4" />
          </button>
        )}
        <span className={cn('text-xs text-muted-foreground', onBack ? '' : 'px-1')}>
          选择要关联的图片
        </span>
      </div>
      {images.length === 0 ? (
        <p className="px-2 pb-2 text-xs leading-relaxed text-muted-foreground">
          这篇记录里还没有图片,先插入一张再来关联。
        </p>
      ) : (
        <div className="flex max-h-72 flex-col overflow-y-auto">
          {images.map((img) => (
            <button
              key={img.attachmentId}
              type="button"
              role="menuitemradio"
              aria-checked={current === img.attachmentId}
              onPointerEnter={() => setActiveLink(editor, img.attachmentId)}
              onFocus={() => setActiveLink(editor, img.attachmentId)}
              onClick={() => {
                appliedRef.current = true
                onClose()
                applyLink(editor, request.range, img.attachmentId)
              }}
              className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors outline-none hover:bg-muted focus-visible:bg-muted"
            >
              <Thumb imageId={img.attachmentId} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm">{img.label}</span>
                <span className="text-xs text-muted-foreground">{IMAGE_LAYOUT_LABEL[img.layout]}</span>
              </span>
              {current === img.attachmentId && <Check className="size-4 shrink-0 text-muted-foreground" />}
            </button>
          ))}
        </div>
      )}
    </>
  )
}

function Thumb({ imageId }: { imageId: string }) {
  const entry = useAttachment(imageId)
  return (
    <span className="block size-10 shrink-0 overflow-hidden rounded-sm border border-border bg-muted">
      {entry?.status === 'ready' && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={entry.url} alt="" className="size-full object-cover" draggable={false} />
      )}
    </span>
  )
}

/* ── 基础件 ───────────────────────────────────────────── */

function MenuItem({
  icon,
  children,
  onSelect,
  role = 'menuitem',
  checked,
  disabled,
  tone,
}: {
  icon?: ReactNode
  children: ReactNode
  onSelect: () => void
  role?: 'menuitem' | 'menuitemradio'
  checked?: boolean
  disabled?: boolean
  tone?: 'destructive'
}) {
  return (
    <button
      type="button"
      role={role}
      aria-checked={role === 'menuitemradio' ? !!checked : undefined}
      aria-disabled={disabled || undefined}
      tabIndex={-1}
      onClick={() => {
        if (!disabled) onSelect()
      }}
      className={cn(
        'flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left transition-colors outline-none',
        disabled
          ? 'cursor-default opacity-45'
          : 'hover:bg-muted focus-visible:bg-muted',
        tone === 'destructive' && !disabled ? 'hover:text-destructive focus-visible:text-destructive' : '',
      )}
    >
      <span className="flex w-6 shrink-0 items-center justify-center text-muted-foreground">{icon}</span>
      <span className="flex-1 truncate">{children}</span>
      {role === 'menuitemradio' && checked && <Check className="size-4 shrink-0 text-muted-foreground" />}
    </button>
  )
}

function MenuLabel({ children }: { children: ReactNode }) {
  return <p className="px-2 pt-2 pb-1 text-xs text-muted-foreground">{children}</p>
}

function MenuSeparator() {
  return <div role="separator" className="-mx-1 my-1 h-px bg-border" />
}

/* 版式示意:一眼看出图和文字的相对位置。24×16 */
type Bar = [left: number, top: number, width: number]
const GLYPHS: Record<ImageLayout, { img: [number, number, number, number]; bars: Bar[] }> = {
  block: { img: [5, 0, 14, 8], bars: [[0, 11, 24], [0, 14, 17]] },
  'wrap-left': { img: [0, 1, 9, 8], bars: [[11, 2, 13], [11, 5, 13], [11, 8, 10], [0, 11, 24], [0, 14, 16]] },
  'wrap-right': { img: [15, 1, 9, 8], bars: [[0, 2, 13], [0, 5, 13], [0, 8, 10], [0, 11, 24], [0, 14, 16]] },
  'margin-left': { img: [0, 2, 6, 6], bars: [[9, 2, 15], [9, 5, 15], [9, 8, 15], [9, 11, 15], [9, 14, 10]] },
  'margin-right': { img: [18, 2, 6, 6], bars: [[0, 2, 15], [0, 5, 15], [0, 8, 15], [0, 11, 15], [0, 14, 10]] },
}

function LayoutGlyph({ layout }: { layout: ImageLayout }) {
  const glyph = GLYPHS[layout]
  const [l, t, w, h] = glyph.img
  return (
    <span aria-hidden="true" className="relative block h-4 w-6">
      <span
        className="absolute rounded-[1px] bg-current opacity-80"
        style={{ left: l, top: t, width: w, height: h }}
      />
      {glyph.bars.map(([bl, bt, bw]) => (
        <span
          key={`${bl}-${bt}`}
          className="absolute h-px bg-current opacity-50"
          style={{ left: bl, top: bt, width: bw }}
        />
      ))}
    </span>
  )
}
