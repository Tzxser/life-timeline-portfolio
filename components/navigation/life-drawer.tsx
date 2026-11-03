'use client'

// 左侧人生目录:按人生阶段分组的事件列表,辅助导航

import { useMemo, useState } from 'react'
import { Search, X } from 'lucide-react'
import { formatCompactDate, type LifeEvent } from '@/types/life-event'
import { isEventInStage, type LifeStage } from '@/types/life-stage'
import { Overlay } from '@/components/common/overlay'
import { eventSearchText } from '@/lib/rich-content'
import { cn } from '@/lib/utils'

const UNGROUPED = '__ungrouped__'

interface LifeDrawerProps {
  open: boolean
  events: LifeEvent[]
  stages: LifeStage[]
  selectedId: string | null
  onClose: () => void
  onSelectEvent: (id: string) => void
}

export function LifeDrawer({
  open,
  events,
  stages,
  selectedId,
  onClose,
  onSelectEvent,
}: LifeDrawerProps) {
  const [query, setQuery] = useState('')

  // 按用户创建的阶段分组;不落入任何阶段的事件归入"其他时间"
  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = q ? events.filter((e) => eventSearchText(e).includes(q)) : events
    const map = new Map<string, LifeEvent[]>()
    for (const stage of stages) map.set(stage.id, [])
    map.set(UNGROUPED, [])
    for (const e of filtered) {
      const stage = stages.find((s) => isEventInStage(e, s))
      map.get(stage ? stage.id : UNGROUPED)?.push(e)
    }
    return map
  }, [events, stages, query])

  const total = events.length

  return (
    <Overlay open={open} onClose={onClose} align="left" label="人生目录">
      <div className="flex h-full w-80 max-w-[85vw] flex-col bg-background shadow-xl">
        <header className="flex items-center justify-between px-5 pt-5 pb-3">
          <span className="font-mono text-xs tracking-[0.2em] text-muted-foreground">LIFE</span>
          <button
            type="button"
            onClick={onClose}
            className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="关闭目录"
          >
            <X className="size-4" />
          </button>
        </header>

        {/* 目录内搜索 */}
        <div className="px-5 pb-4">
          <div className="flex items-center gap-2 rounded-md border border-input bg-background px-3 py-2 transition-colors focus-within:border-ring">
            <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索人生……"
              className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/60"
              aria-label="搜索人生记录"
            />
          </div>
        </div>

        <nav aria-label="全部记忆" className="flex-1 overflow-y-auto px-3 pb-6">
          <p className="px-2 pb-2 text-xs text-muted-foreground">
            全部记忆 <span className="font-mono tabular-nums">{total}</span>
          </p>
          {[
            ...stages.map((s) => ({ id: s.id, name: s.name })),
            { id: UNGROUPED, name: '其他时间' },
          ].map((group) => {
            const items = grouped.get(group.id) ?? []
            if (items.length === 0) return null
            return (
              <div key={group.id} className="mb-4">
                <p className="px-2 py-1.5 text-xs font-medium tracking-wide text-muted-foreground/80">
                  {group.name}
                </p>
                <ul className="flex flex-col">
                  {items.map((event) => (
                    <li key={event.id}>
                      <button
                        type="button"
                        onClick={() => {
                          onSelectEvent(event.id)
                          onClose()
                        }}
                        className={cn(
                          'flex w-full items-baseline justify-between gap-3 rounded-md px-2 py-1.5 text-left transition-colors',
                          event.id === selectedId
                            ? 'bg-muted text-foreground'
                            : 'text-foreground/80 hover:bg-muted/60 hover:text-foreground',
                        )}
                      >
                        <span className="min-w-0 truncate text-sm">{event.title}</span>
                        <span className="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">
                          {formatCompactDate(event)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}
        </nav>
      </div>
    </Overlay>
  )
}
