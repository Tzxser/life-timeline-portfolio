'use client'

// 日期卡片:整条时间轴共享的一张卡(§56)。
//   hover 态:轻量预览 —— 日期 + 记录数 + 标题列表(§19)
//   pinned 态(点击含多条记录的日刻度):列表变成可点的选择项(§20)
// 永远只有这一个 DOM 实例,根据当前 hovered / pinned 的日期桶更新内容。

import type { DayBucket } from '@/lib/timeline-geometry'

interface TimelineDayCardProps {
  bucket: DayBucket
  /** true = 点击固定,列表可选;false = 纯 hover 预览 */
  pinned: boolean
  axisY: number
  onSelectEvent: (id: string) => void
  onClose: () => void
  /** 指针进入卡片:取消悬停关闭的宽限计时(hover 接力) */
  onPointerEnterCard: () => void
}

export function TimelineDayCard({
  bucket,
  pinned,
  axisY,
  onSelectEvent,
  onClose,
  onPointerEnterCard,
}: TimelineDayCardProps) {
  const { year, month, day, events } = bucket
  return (
    <div
      className="animate-preview-in absolute z-30 w-52 -translate-x-1/2 rounded-md border border-border bg-popover px-3 py-2.5 text-popover-foreground shadow-md"
      style={{ left: bucket.x, top: axisY + 26 }}
      role={pinned ? 'menu' : 'tooltip'}
      onPointerEnter={onPointerEnterCard}
      onPointerLeave={pinned ? undefined : onClose}
    >
      <p className="font-mono text-[11px] tracking-wide text-muted-foreground tabular-nums">
        {year} 年 {month} 月 {day} 日
      </p>
      {events.length > 1 && (
        <p className="mt-0.5 text-[11px] text-muted-foreground/70">{events.length} 条记录</p>
      )}
      {/* hover 与 pinned 两种状态下条目都可点:悬停接力已保证卡片不会在指针飞行途中消失 */}
      <ul className="mt-1.5 flex flex-col gap-0.5">
        {events.slice(0, 6).map((event) => (
          <li key={event.id}>
            <button
              type="button"
              role={pinned ? 'menuitem' : undefined}
              onClick={() => {
                onSelectEvent(event.id)
                onClose()
              }}
              className="w-full truncate rounded-sm px-1.5 py-1 text-left text-[13px] text-foreground/90 transition-colors hover:bg-muted hover:text-foreground"
            >
              {events.length > 1 ? '· ' : ''}
              {event.title}
            </button>
          </li>
        ))}
        {events.length > 6 && (
          <li className="px-1.5 text-[11px] text-muted-foreground/60">
            还有 {events.length - 6} 条…
          </li>
        )}
      </ul>
    </div>
  )
}
