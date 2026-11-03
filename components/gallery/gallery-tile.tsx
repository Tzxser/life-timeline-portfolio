'use client'

// 图集里的一格。图片按原始比例排列;视频显示首帧,悬停时静音预览;
// 音频没有画面,就是一张安静的“磁带标签”:文件名、时长与所在的记录。

import { useRef, useState, type MouseEvent } from 'react'
import { AudioLines, Play } from 'lucide-react'
import { formatDuration, type GalleryItem } from '@/lib/gallery'
import { cn } from '@/lib/utils'

interface GalleryTileProps {
  item: GalleryItem
  index: number
  onOpen: () => void
  onMenu: (x: number, y: number) => void
}

export function GalleryTile({ item, index, onOpen, onMenu }: GalleryTileProps) {
  const [duration, setDuration] = useState('')
  const [failed, setFailed] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)

  const onContextMenu = (e: MouseEvent<HTMLButtonElement>) => {
    e.preventDefault()
    // 键盘唤出菜单(菜单键 / Shift+F10)时没有鼠标坐标,改为贴着卡片打开
    if (e.clientX === 0 && e.clientY === 0) {
      const r = e.currentTarget.getBoundingClientRect()
      onMenu(r.left + 12, r.top + 12)
    } else onMenu(e.clientX, e.clientY)
  }

  const playPreview = () => {
    const v = videoRef.current
    if (!v || failed) return
    v.play().catch(() => {})
  }
  const stopPreview = () => {
    const v = videoRef.current
    if (!v) return
    v.pause()
    v.currentTime = 0
  }

  const ratio = item.width && item.height ? `${item.width} / ${item.height}` : item.kind === 'video' ? '16 / 9' : undefined
  const label = item.caption || item.name

  return (
    <button
      type="button"
      onClick={onOpen}
      onContextMenu={onContextMenu}
      onMouseEnter={item.kind === 'video' ? playPreview : undefined}
      onMouseLeave={item.kind === 'video' ? stopPreview : undefined}
      onFocus={item.kind === 'video' ? playPreview : undefined}
      onBlur={item.kind === 'video' ? stopPreview : undefined}
      aria-label={`${label},${item.compactDate} · ${item.eventTitle}。右键可回到原文`}
      className="group/tile animate-preview-in flex w-full flex-col gap-2 text-left focus-visible:outline-none"
      style={{ animationDelay: `${Math.min(index, 12) * 35}ms` }}
    >
      {item.kind === 'audio' ? (
        <span className="flex w-full items-center gap-3 rounded-sm border border-border bg-card px-3 py-4 text-card-foreground transition-colors group-hover/tile:border-foreground/30 group-focus-visible/tile:ring-2 group-focus-visible/tile:ring-ring group-focus-visible/tile:ring-offset-2 group-focus-visible/tile:ring-offset-background">
          <span className="lt-audio-disc flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <AudioLines className="size-4" aria-hidden="true" />
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-sm text-foreground" title={item.name}>
              {item.name}
            </span>
            <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
              音频{duration ? ` · ${duration}` : ''}
            </span>
          </span>
          {/* 只读取时长,不播放 */}
          <audio
            src={item.url}
            preload="metadata"
            className="hidden"
            onLoadedMetadata={(e) => setDuration(formatDuration(e.currentTarget.duration))}
          />
        </span>
      ) : (
        <span
          className="relative block w-full overflow-hidden rounded-sm bg-muted ring-offset-2 ring-offset-background group-focus-visible/tile:ring-2 group-focus-visible/tile:ring-ring"
          style={{ aspectRatio: ratio }}
        >
          {item.kind === 'image' ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={item.url}
              alt={label}
              loading="lazy"
              decoding="async"
              className="block size-full object-cover transition-transform duration-700 ease-out group-hover/tile:scale-[1.03]"
            />
          ) : failed ? (
            <span className="flex size-full items-center justify-center px-3 text-center text-xs leading-relaxed text-muted-foreground">
              浏览器无法预览这个视频格式
            </span>
          ) : (
            <>
              <video
                ref={videoRef}
                src={`${item.url}#t=0.1`}
                muted
                loop
                playsInline
                preload="metadata"
                aria-hidden="true"
                className="block size-full object-cover"
                onLoadedMetadata={(e) => setDuration(formatDuration(e.currentTarget.duration))}
                onError={() => setFailed(true)}
              />
              <span
                aria-hidden="true"
                className="absolute inset-0 flex items-center justify-center transition-opacity duration-300 group-hover/tile:opacity-0"
              >
                <span className="flex size-10 items-center justify-center rounded-full bg-background/80 text-foreground backdrop-blur-sm">
                  <Play className="size-4 translate-x-px" />
                </span>
              </span>
            </>
          )}
          {item.kind === 'video' && duration && (
            <span className="absolute right-1.5 bottom-1.5 rounded bg-background/80 px-1.5 py-0.5 font-mono text-[10px] text-foreground tabular-nums backdrop-blur-sm">
              {duration}
            </span>
          )}
        </span>
      )}

      <span className="flex w-full items-baseline justify-between gap-2">
        <span className={cn('min-w-0 truncate font-serif text-sm text-foreground/85 transition-colors group-hover/tile:text-foreground')}>
          {item.eventTitle}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">{item.compactDate}</span>
      </span>
      {item.caption && (
        <span className="-mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{item.caption}</span>
      )}
    </button>
  )
}
