'use client'

// 图集:把散落在各篇记录里的图片 / 视频 / 音频,按 年 → 月 重新排成一本相册。
// 它是覆盖在人生空间之上的一整页,而不是另一个路由 —— 关掉它,时间轴、正文、
// 光标与滚动位置都原样还在;“回到原文”也只是在同一个空间里换一篇、滚到那个位置。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import type { LifeEvent } from '@/types/life-event'
import { registerOverlay } from '@/lib/overlay-registry'
import {
  MEDIA_KIND_LABEL,
  collectGalleryItems,
  countByKind,
  groupByYearMonth,
  type GalleryItem,
  type MediaKind,
} from '@/lib/gallery'
import { useAttachmentVersion } from '@/lib/session-attachments'
import { cn } from '@/lib/utils'
import { GalleryTile } from './gallery-tile'
import { GalleryMenu, type GalleryMenuRequest } from './gallery-menu'
import { MediaLightbox } from './media-lightbox'

interface GalleryViewProps {
  open: boolean
  events: LifeEvent[]
  onClose: () => void
  onReveal: (eventId: string, attachmentId: string) => void
}

export function GalleryView(props: GalleryViewProps) {
  if (!props.open) return null
  return <GalleryPage {...props} />
}

type Filter = 'all' | MediaKind
const FILTERS: Filter[] = ['all', 'image', 'video', 'audio']

function GalleryPage({ events, onClose, onReveal }: GalleryViewProps) {
  // Cold-start desktop metadata and controlled asset URLs arrive asynchronously;
  // subscribe without changing the gallery's grouping or image layout logic.
  useAttachmentVersion()
  const items = useMemo(() => collectGalleryItems(events), [events])
  const counts = useMemo(() => countByKind(items), [items])
  const eventCount = useMemo(() => new Set(items.map((i) => i.eventId)).size, [items])

  const [filter, setFilter] = useState<Filter>('all')
  const visible = useMemo(
    () => (filter === 'all' ? items : items.filter((i) => i.kind === filter)),
    [items, filter],
  )
  const years = useMemo(() => groupByYearMonth(visible), [visible])

  const [menu, setMenu] = useState<GalleryMenuRequest | null>(null)
  const [preview, setPreview] = useState<GalleryItem | null>(null)
  const [activeKey, setActiveKey] = useState<string | null>(null)

  const scrollRef = useRef<HTMLDivElement>(null)
  const backRef = useRef<HTMLButtonElement>(null)

  /* 打开:锁住背后的页面滚动、暂停边缘翻篇;关闭:焦点回到打开前的位置 */
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null
    const release = registerOverlay()
    document.body.style.overflow = 'hidden'
    backRef.current?.focus({ preventScroll: true })
    return () => {
      document.body.style.overflow = ''
      release()
      previousFocus?.focus?.({ preventScroll: true })
    }
  }, [])

  // 大图与右键菜单都在捕获阶段吞掉 Escape;走到这里说明它们都没打开
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  /* 左侧年月索引跟随滚动高亮 */
  useEffect(() => {
    const root = scrollRef.current
    if (!root) return
    let frame = 0
    const update = () => {
      frame = 0
      const top = root.getBoundingClientRect().top + 72
      let current: string | null = null
      for (const el of root.querySelectorAll<HTMLElement>('[data-gallery-month]')) {
        if (el.getBoundingClientRect().top <= top) current = el.dataset.galleryMonth ?? null
        else break
      }
      setActiveKey(current ?? years[0]?.months[0]?.key ?? null)
    }
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }
    update()
    root.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      root.removeEventListener('scroll', onScroll)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [years])

  const jumpTo = (key: string) => {
    const root = scrollRef.current
    const el = root?.querySelector<HTMLElement>(`[data-gallery-month="${key}"]`)
    if (!root || !el) return
    root.scrollTo({ top: el.offsetTop - 56, behavior: 'smooth' })
  }

  const reveal = useCallback(
    (item: GalleryItem) => {
      setMenu(null)
      setPreview(null)
      onReveal(item.eventId, item.attachmentId)
    },
    [onReveal],
  )

  const summary = FILTERS.slice(1)
    .filter((k) => counts[k as MediaKind] > 0)
    .map((k) => `${counts[k as MediaKind]} ${k === 'image' ? '张' : '段'}${MEDIA_KIND_LABEL[k as MediaKind]}`)
    .join(' · ')

  let tileIndex = 0

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="gallery-title"
      className="lt-gallery-page animate-view-in fixed inset-0 z-40 flex flex-col bg-background text-foreground"
    >
      <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b border-border px-6 py-4 md:px-10">
        <div className="flex items-center gap-3">
          <button
            ref={backRef}
            type="button"
            onClick={onClose}
            aria-label="返回人生时间轴"
            title="返回(Esc)"
            className="flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <ArrowLeft className="size-4" />
          </button>
          <div className="flex flex-col">
            <h1 id="gallery-title" className="font-serif text-lg leading-tight tracking-wide">
              图集
            </h1>
            <p className="font-mono text-xs text-muted-foreground tabular-nums">
              {items.length === 0 ? '还没有收录' : `${summary} · 来自 ${eventCount} 篇记录`}
            </p>
          </div>
        </div>

        {items.length > 0 && (
          <div role="radiogroup" aria-label="按类型筛选" className="flex items-center gap-1 rounded-md border border-border p-0.5">
            {FILTERS.map((key) => {
              const count = key === 'all' ? items.length : counts[key]
              if (key !== 'all' && count === 0) return null
              const checked = filter === key
              return (
                <button
                  key={key}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  onClick={() => {
                    setFilter(key)
                    scrollRef.current?.scrollTo({ top: 0 })
                  }}
                  className={cn(
                    'flex h-7 items-center gap-1.5 rounded px-2.5 text-sm transition-colors',
                    checked ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {key === 'all' ? '全部' : MEDIA_KIND_LABEL[key]}
                  <span className="font-mono text-[11px] text-muted-foreground tabular-nums">{count}</span>
                </button>
              )
            })}
          </div>
        )}
      </header>

      {items.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <p className="font-serif text-base text-foreground">这里还是空的</p>
          <p className="max-w-sm text-sm leading-relaxed text-muted-foreground text-pretty">
            在任何一篇记录里插入图片,或添加视频、音频附件,它们会自动按年月收进图集。
          </p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <nav aria-label="按年月跳转" className="hidden w-40 shrink-0 overflow-y-auto border-r border-border py-8 pr-4 pl-6 md:block md:pl-10 lg:w-48">
            <ol className="flex flex-col gap-5">
              {years.map((year) => (
                <li key={year.year} className="flex flex-col gap-1">
                  <span className="font-mono text-sm text-foreground tabular-nums">{year.year}</span>
                  <ol className="flex flex-col">
                    {year.months.map((month) => {
                      const active = activeKey === month.key
                      return (
                        <li key={month.key}>
                          <button
                            type="button"
                            onClick={() => jumpTo(month.key)}
                            aria-current={active ? 'true' : undefined}
                            className={cn(
                              'flex w-full items-center justify-between gap-2 rounded py-1 pr-1 pl-3 text-left text-sm transition-colors',
                              active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
                            )}
                          >
                            <span className="relative">
                              {active && (
                                <span aria-hidden="true" className="absolute top-1/2 -left-3 h-3 w-px -translate-y-1/2 bg-foreground" />
                              )}
                              {month.label}
                            </span>
                            <span className="font-mono text-[11px] tabular-nums">{month.items.length}</span>
                          </button>
                        </li>
                      )
                    })}
                  </ol>
                </li>
              ))}
            </ol>
          </nav>

          <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 pb-24 md:px-10">
            {years.length === 0 && (
              <p className="py-16 text-center text-sm text-muted-foreground">这一类还没有内容</p>
            )}
            {years.map((year) => (
              <section key={year.year} aria-label={`${year.year} 年`}>
                <h2 className="sticky top-0 z-10 flex items-baseline gap-3 bg-background/95 pt-8 pb-4 backdrop-blur-sm">
                  <span className="font-mono text-2xl tracking-tight text-foreground tabular-nums">{year.year}</span>
                  <span className="font-mono text-xs text-muted-foreground tabular-nums">{year.count}</span>
                </h2>

                {year.months.map((month) => (
                  <div key={month.key} data-gallery-month={month.key} className="pb-10">
                    <h3 className="mb-4 flex items-center gap-3">
                      <span className="font-serif text-sm text-foreground">{month.label}</span>
                      <span aria-hidden="true" className="h-px flex-1 bg-border" />
                    </h3>
                    <ul className="columns-2 gap-4 sm:columns-3 xl:columns-4">
                      {month.items.map((item) => (
                        <li key={item.key} className="mb-5 break-inside-avoid">
                          <GalleryTile
                            item={item}
                            index={tileIndex++}
                            onOpen={() => setPreview(item)}
                            onMenu={(x, y) => setMenu({ x, y, item })}
                          />
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </section>
            ))}
          </div>
        </div>
      )}

      {menu && (
        <GalleryMenu
          request={menu}
          onClose={() => setMenu(null)}
          onPreview={() => {
            setPreview(menu.item)
            setMenu(null)
          }}
          onReveal={() => reveal(menu.item)}
        />
      )}
      {preview && <MediaLightbox item={preview} onClose={() => setPreview(null)} onReveal={() => reveal(preview)} />}
    </div>
  )
}
