'use client'

// 人生事件标记:圆点体系已退役,事件现在是时间尺上的一根"事件刻度"(§5, §57)。
//   · 从主轴向上延伸,比年刻度略矮但更实,重要事件更高
//   · 标题绑定在刻度顶端,分两行错位排布避免互相叠压(§24)
//   · 模糊时间用虚线刻度 + ≈ 表达,不伪装成精确日期(§23)
//   · 当前选中:强调色 + 刻度顶端一个小三角标记 —— 依然是尺,不回到大圆点

import { memo } from 'react'
import { cn } from '@/lib/utils'
import type { LifeEvent } from '@/types/life-event'
import { seasonalTree } from '@/lib/seasonal-timeline'
import { renderSeasonTree } from '@/lib/seasonal-art'

interface TimelineNodeProps {
  event: LifeEvent
  x: number
  selected: boolean
  fuzzy: boolean
  /** 标题行:0 = 靠近刻度,1 = 更高一行(错位避让) */
  labelRow: 0 | 1
  labelHidden?: boolean
  axisY: number
  /** 纵向视觉倍率 */
  v: number
  labelSize: number
  /**
   * 主轴上方留给日刻度桶的浅带高度(§19)。
   * 日刻度与事件刻度现在同在轴上方,靠这条带划分指针领土:
   * 事件的热区从带的上沿开始,刻度线仍然一路画到主轴(视觉连续,不参与命中)。
   */
  dayBandH: number
  onSelect: (id: string) => void
  seasonal?: boolean
}

export const TimelineNode = memo(function TimelineNode({
  event,
  x,
  selected,
  fuzzy,
  labelRow,
  labelHidden = false,
  axisY,
  v,
  labelSize,
  dayBandH,
  onSelect,
  seasonal = false,
}: TimelineNodeProps) {
  const important = event.importance >= 4
  // 事件刻度高度:重要性越高越高;行 1 的刻度更长,把标题送到更高的行。
  // 行 1 抬升取 44:最坏组合(行 0 是重要事件 34、行 1 是普通事件 26+44)
  // 下两行标签的实际行距仍有 36px,大于标签块高(标题+日期 ≈ 34px)。
  const tickH = (important ? 34 : 26) * v + (labelRow === 1 ? 44 * v : 0)

  const color = selected
    ? 'var(--tlc-selected, var(--color-primary))'
    : 'var(--tlc-node, color-mix(in oklab, var(--color-foreground) 55%, transparent))'
  const tree = seasonal ? seasonalTree(event, tickH + dayBandH, v) : null

  return (
    <button
      type="button"
      onClick={() => onSelect(event.id)}
      className={cn(
        'group absolute -translate-x-1/2 outline-none',
        'hover:z-20 focus-visible:z-20',
        selected && 'z-10',
      )}
      // 热区止步于日刻度带的上沿:紧贴主轴的那条浅带是日刻度桶的领土
      style={{ left: x, top: axisY - dayBandH - tickH, height: tickH }}
      aria-pressed={selected}
      aria-label={`${event.title},${event.displayDate}`}
      data-timeline-event={event.id}
    >
      {/* 扩大点击热区 */}
      <span className={cn('absolute inset-y-0', seasonal ? '-inset-x-5' : '-inset-x-3')} aria-hidden="true" />

      {/* 事件刻度线:一路画到主轴(含日刻度带),但不参与命中 —— 那条带属于日刻度桶 */}
      {tree ? <svg
        className="lt-seasonal-tree pointer-events-none absolute left-1/2 -translate-x-1/2"
        data-seasonal-tree={event.datePrecision}
        data-fuzzy={fuzzy}
        aria-hidden="true"
        focusable="false"
        width={90}
        height={tickH + dayBandH + 4}
        viewBox={`-45 ${-(tickH + dayBandH)} 90 ${tickH + dayBandH + 4}`}
        style={{ top: 0, color: tree.color }}
        dangerouslySetInnerHTML={{ __html: renderSeasonTree(tree.ink, tree.geometry) }}
      /> : <span
        className="pointer-events-none absolute left-1/2 -translate-x-1/2 transition-colors duration-300"
        style={{
          top: 0,
          height: tickH + dayBandH,
          width: selected ? 2 : 1.5,
          background: fuzzy
            ? `repeating-linear-gradient(to bottom, ${color} 0 3px, transparent 3px 6px)`
            : color,
          ...(selected && {
            transform: 'translateX(-50%) scaleY(calc(1 + 0.16 * var(--tl-p)))',
            transformOrigin: '50% 100%',
          }),
        }}
      />}

      {/* 选中标记:刻度顶端一枚极小的实心菱形 */}
      {selected && (
        <span
          className="absolute left-1/2 size-[7px] -translate-x-1/2 rotate-45"
          style={{ top: -5, background: 'var(--tlc-selected, var(--color-primary))' }}
        />
      )}

      {/* 悬停强调:与刻度线同长,同样不参与命中 */}
      <span
        className="pointer-events-none absolute top-0 left-1/2 w-px -translate-x-1/2 bg-primary opacity-0 transition-opacity group-hover:opacity-60"
        style={{ height: tickH + dayBandH, background: 'var(--tlc-selected, var(--color-primary))' }}
        aria-hidden="true"
      />

      {/* 标题:绑定在刻度顶端 */}
      <span
        className={cn(
          'absolute bottom-full left-1/2 mb-1 flex w-max max-w-36 -translate-x-1/2 flex-col items-center gap-px text-center transition-all duration-300',
          selected
            ? 'text-[color:var(--tlc-node-label-selected,var(--color-foreground))]'
            : 'text-[color:var(--tlc-node-label,var(--color-muted-foreground))] group-hover:text-[color:var(--tlc-node-label-hover,var(--color-foreground))]',
          labelHidden &&
            !selected &&
            'pointer-events-none opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100',
          labelHidden && 'rounded-sm bg-background/95 px-1 py-0.5',
        )}
      >
        <span
          className={cn(
            'max-w-full truncate leading-snug',
            selected ? 'font-medium' : important ? 'font-normal' : 'font-normal opacity-90',
          )}
          style={{ fontSize: labelSize }}
        >
          {event.title}
        </span>
        <span className="max-w-full truncate font-mono text-[10px] tracking-wide opacity-70 tabular-nums">
          {fuzzy && !event.displayDate.includes('≈') ? `≈ ${event.displayDate}` : event.displayDate}
        </span>
      </span>
    </button>
  )
})

TimelineNode.displayName = 'TimelineNode'
