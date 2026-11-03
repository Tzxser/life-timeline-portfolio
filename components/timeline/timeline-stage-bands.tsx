'use client'

// 人生阶段在时间轴上的空间表达:极轻的一条细线 + 小字名称
// 只负责告诉用户"这个阶段位于人生的哪一段",不抢事件节点的视觉注意力。
// 阶段允许互相重叠,因此用贪心算法把重叠的阶段分配到不同的行。

import { stageRange, type LifeStage } from '@/types/life-stage'
import { cn } from '@/lib/utils'

const LANE_HEIGHT = 13 // 每行的竖向间距(px)
const LANE_BOTTOM = 6 // 第一行距底部的距离(px)

interface TimelineStageBandsProps {
  stages: LifeStage[]
  activeStageId: string
  yearToX: (year: number) => number
  /** 视口左边缘对应的内容坐标,用于把长阶段的名称保持在可见范围内 */
  scrollLeft: number
  /** 视口宽度 */
  viewportWidth: number
}

export function TimelineStageBands({
  stages,
  activeStageId,
  yearToX,
  scrollLeft,
  viewportWidth,
}: TimelineStageBandsProps) {
  // 贪心分行:与本行已有区间重叠则换到下一行
  const laneEnds: number[] = []
  const bands = stages.map((stage) => {
    const { start, end } = stageRange(stage)
    let lane = laneEnds.findIndex((laneEnd) => start >= laneEnd)
    if (lane === -1) {
      lane = laneEnds.length
      laneEnds.push(end)
    } else {
      laneEnds[lane] = end
    }
    return { stage, start, end, lane }
  })

  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0">
      {bands.map(({ stage, start, end, lane }) => {
        const left = yearToX(start)
        const width = Math.max(2, yearToX(end) - left)
        const active = stage.id === activeStageId
        return (
          <div
            key={stage.id}
            className="absolute"
            style={{ left, width, bottom: LANE_BOTTOM + lane * LANE_HEIGHT }}
          >
            {/* 阶段本体:一条有厚度的浅色带,当前阶段稍微提亮 —— 不用下划线,避免读成链接 */}
            <span
              className="absolute inset-x-0 bottom-0 h-[9px] rounded-[2px] transition-colors duration-300"
              style={{
                background: active
                  ? 'var(--tlc-stage, color-mix(in oklab, var(--color-primary) 15%, transparent))'
                  : 'var(--tlc-stage-inactive, color-mix(in oklab, var(--color-foreground) 4.5%, transparent))',
              }}
            />
            {/* 起点一个短竖线;非"至今"的阶段在终点也画一个 */}
            <span
              className={cn(
                'absolute bottom-0 left-0 h-[9px] w-px transition-colors duration-300',
                active ? 'bg-primary/40' : 'bg-foreground/15',
              )}
              style={{ background: active ? 'var(--tlc-stage-edge-active)' : 'var(--tlc-stage-edge)' }}
            />
            {!stage.isOngoing && (
              <span
                className={cn(
                  'absolute right-0 bottom-0 h-[9px] w-px transition-colors duration-300',
                  active ? 'bg-primary/40' : 'bg-foreground/15',
                )}
                style={{ background: active ? 'var(--tlc-stage-edge-active)' : 'var(--tlc-stage-edge)' }}
              />
            )}
            {/* 名称跟随视口:阶段很长时,名称停在可见区左侧而不是滑出屏幕 */}
            <span
              className={cn(
                'absolute bottom-[1px] truncate text-[10px] leading-[9px] tracking-wide transition-colors duration-300',
                active ? 'text-foreground/70' : 'text-muted-foreground/40',
              )}
              style={{
                left: Math.min(Math.max(6, scrollLeft - left + 6), Math.max(6, width - 8)),
                maxWidth: Math.max(24, Math.min(width - 8, viewportWidth - 24)),
                color: active ? 'var(--tlc-stage-label-active)' : 'var(--tlc-stage-label)',
              }}
            >
              {stage.name}
            </span>
          </div>
        )
      })}
    </div>
  )
}
