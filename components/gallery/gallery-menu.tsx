'use client'

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { CornerUpLeft, Download, Expand } from 'lucide-react'
import { downloadAttachment } from '@/lib/session-attachments'
import { MEDIA_KIND_LABEL, type GalleryItem } from '@/lib/gallery'

export interface GalleryMenuRequest {
  x: number
  y: number
  item: GalleryItem
}

export function GalleryMenu({
  request,
  onClose,
  onPreview,
  onReveal,
}: {
  request: GalleryMenuRequest
  onClose: () => void
  onPreview: () => void
  onReveal: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: request.x, top: request.y })
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    setPosition({
      left: Math.max(8, Math.min(request.x, window.innerWidth - width - 8)),
      top: request.y + height > window.innerHeight - 8 ? Math.max(8, request.y - height) : request.y,
    })
    el.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true })
  }, [request])

  useEffect(() => {
    const inside = (t: EventTarget | null) => t instanceof Node && ref.current?.contains(t)
    const onPointerDown = (e: PointerEvent) => {
      if (!inside(e.target)) onCloseRef.current()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onCloseRef.current()
    }
    const close = () => onCloseRef.current()
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
    }
  }, [])

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])
    const index = items.indexOf(document.activeElement as HTMLElement)
    let next = -1
    if (e.key === 'ArrowDown') next = (index + 1) % items.length
    else if (e.key === 'ArrowUp') next = (index - 1 + items.length) % items.length
    else if (e.key === 'Tab') {
      e.preventDefault()
      onCloseRef.current()
      return
    }
    if (next === -1) return
    e.preventDefault()
    items[next].focus()
  }

  const { item } = request
  const itemClass =
    'flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm text-popover-foreground outline-none transition-colors hover:bg-muted focus-visible:bg-muted'

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={MEDIA_KIND_LABEL[item.kind]}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
      className="animate-overlay-in fixed z-[70] flex w-60 flex-col rounded-lg border border-border bg-popover p-1 shadow-lg"
      style={position}
    >
      <div className="flex flex-col gap-0.5 px-2.5 pt-2 pb-2">
        <span className="truncate font-serif text-sm text-foreground">{item.eventTitle}</span>
        <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
          {item.compactDate} · {MEDIA_KIND_LABEL[item.kind]}
        </span>
      </div>
      <div className="mx-1 mb-1 h-px bg-border" aria-hidden="true" />
      <button type="button" role="menuitem" onClick={onReveal} className={itemClass}>
        <CornerUpLeft className="size-4 text-muted-foreground" aria-hidden="true" />
        回到原文
      </button>
      <button type="button" role="menuitem" onClick={onPreview} className={itemClass}>
        <Expand className="size-4 text-muted-foreground" aria-hidden="true" />
        {item.kind === 'image' ? '查看大图' : '播放'}
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          downloadAttachment(item.attachmentId)
          onCloseRef.current()
        }}
        className={itemClass}
      >
        <Download className="size-4 text-muted-foreground" aria-hidden="true" />
        下载原文件
      </button>
    </div>,
    document.body,
  )
}
