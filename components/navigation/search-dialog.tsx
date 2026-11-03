'use client'

// 搜索:Command Palette 式界面,搜索标题 / 摘要 / 正文纯文本 / 图片说明 / 附件文件名

import { useEffect, useMemo, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import type { LifeEvent } from '@/types/life-event'
import { eventSearchText } from '@/lib/rich-content'
import { Overlay } from '@/components/common/overlay'
import { cn } from '@/lib/utils'

interface SearchDialogProps {
  open: boolean
  events: LifeEvent[]
  onClose: () => void
  onSelectEvent: (id: string) => void
}

export function SearchDialog({ open, events, onClose, onSelectEvent }: SearchDialogProps) {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setQuery('')
      setActiveIndex(0)
      // 等待渲染完成后聚焦
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return events.slice().reverse().slice(0, 8)
    return events.filter((e) => eventSearchText(e).includes(q))
  }, [events, query])

  const pick = (id: string) => {
    onSelectEvent(id)
    onClose()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      if (e.nativeEvent.isComposing || e.keyCode === 229) return
      const target = results[activeIndex]
      if (target) pick(target.id)
    }
  }

  return (
    <Overlay open={open} onClose={onClose} align="center-top" label="搜索人生记录">
      <div className="overflow-hidden rounded-lg border border-border bg-background shadow-xl">
        <div className="flex items-center gap-3 border-b border-border/70 px-4 py-3.5">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActiveIndex(0)
            }}
            onKeyDown={onKeyDown}
            placeholder="搜索你的人生……"
            className="w-full bg-transparent text-base text-foreground outline-none placeholder:text-muted-foreground/60"
            aria-label="搜索你的人生"
          />
          <kbd className="hidden shrink-0 rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground md:block">
            Esc
          </kbd>
        </div>

        <ul className="max-h-[50vh] overflow-y-auto py-2" role="listbox" aria-label="搜索结果">
          {results.length === 0 && (
            <li className="px-4 py-8 text-center text-sm text-muted-foreground">
              没有找到相关的记录
            </li>
          )}
          {results.map((event, i) => (
            <li key={event.id} role="option" aria-selected={i === activeIndex}>
              <button
                type="button"
                onClick={() => pick(event.id)}
                onMouseEnter={() => setActiveIndex(i)}
                className={cn(
                  'flex w-full flex-col gap-0.5 px-4 py-2.5 text-left transition-colors',
                  i === activeIndex ? 'bg-muted' : '',
                )}
              >
                <span className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate text-sm text-foreground">{event.title}</span>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">
                    {event.date.split('-')[0]}
                  </span>
                </span>
                <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                  {event.displayDate}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Overlay>
  )
}
