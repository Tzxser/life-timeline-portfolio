'use client'

// 图集里的大图 / 播放层。底部始终带着出处与「回到原文」,看完可以直接回去读那一篇。

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AudioLines, CornerUpLeft, X } from 'lucide-react'
import type { GalleryItem } from '@/lib/gallery'

export function MediaLightbox({
  item,
  onClose,
  onReveal,
}: {
  item: GalleryItem
  onClose: () => void
  onReveal: () => void
}) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const onCloseRef = useRef(onClose)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null
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
      previousFocus?.focus?.({ preventScroll: true })
    }
  }, [])

  const label = item.caption || item.name

  return createPortal(
    <div
      className="animate-overlay-in fixed inset-0 z-[60] flex flex-col items-center justify-center gap-4 p-6"
      role="dialog"
      aria-modal="true"
      aria-label={`预览:${label}`}
    >
      <button
        type="button"
        aria-label="关闭预览"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-zoom-out bg-background/95"
      />

      {failed ? (
        <p className="relative max-w-sm text-center text-sm leading-relaxed text-muted-foreground">
          浏览器无法播放这个文件的格式,可以右键卡片下载原文件后用本地播放器打开。
        </p>
      ) : item.kind === 'image' ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={item.url} alt={label} className="relative max-h-[76vh] max-w-full rounded-sm object-contain shadow-lg" />
      ) : item.kind === 'video' ? (
        <video
          src={item.url}
          controls
          autoPlay
          playsInline
          onError={() => setFailed(true)}
          className="relative max-h-[76vh] max-w-full rounded-sm bg-foreground/5 shadow-lg"
        />
      ) : (
        <div className="relative flex w-full max-w-md flex-col items-center gap-5 rounded-lg border border-border bg-card px-6 py-8 text-card-foreground shadow-lg">
          <span className="lt-audio-disc is-playing flex size-16 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <AudioLines className="size-6" aria-hidden="true" />
          </span>
          <span className="max-w-full truncate text-sm text-foreground" title={item.name}>
            {item.name}
          </span>
          <audio src={item.url} controls autoPlay onError={() => setFailed(true)} className="w-full" />
        </div>
      )}

      <div className="relative flex max-w-xl flex-col items-center gap-3 text-center">
        {item.caption && <p className="font-serif text-sm leading-relaxed text-muted-foreground">{item.caption}</p>}
        <div className="flex items-center gap-3">
          <span className="font-mono text-xs text-muted-foreground tabular-nums">
            {item.compactDate} · {item.eventTitle}
          </span>
          <button
            type="button"
            onClick={onReveal}
            className="flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-sm text-foreground transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <CornerUpLeft className="size-3.5" aria-hidden="true" />
            回到原文
          </button>
        </div>
      </div>

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
