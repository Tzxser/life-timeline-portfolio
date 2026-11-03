// 人生阶段:不是标签,而是一个有时间范围的"阶段对象"
// 事件是人生里的点,阶段是人生里的段。除"全部"外,所有阶段都由用户自己创建。

import { dateToDecimalYear, type DatePrecision, type LifeEvent } from './life-event'

/** range = 绑定一个时间块;ongoing = 从某个时刻持续到至今 */
export type StageType = 'range' | 'ongoing'

export interface LifeStage {
  id: string
  name: string
  type: StageType
  /** 规范化开始时间,如 "2015-09" */
  startDate: string
  /** 人类可读开始时间,如 "2015 年 9 月"、"≈ 2012" */
  startDisplay: string
  startPrecision: DatePrecision
  /** ongoing 阶段为 null */
  endDate: string | null
  endDisplay: string | null
  endPrecision: DatePrecision | null
  isOngoing: boolean
  description?: string
}

/** "全部"是唯一的系统阶段:永远存在、永远第一、不可编辑 / 删除 / 重命名 */
export const ALL_STAGE_ID = 'stage-all'
export const ALL_STAGE_NAME = '全部'

/** 阶段对应的时间范围(十进制年),ongoing 阶段的结束点为"现在" */
export function stageRange(stage: LifeStage): { start: number; end: number } {
  const start = dateToDecimalYear(stage.startDate)
  if (stage.isOngoing || !stage.endDate) {
    const now = new Date()
    // 只留一个月余量:既能覆盖当月的记录,又不会让"至今"越过现在
    return { start, end: now.getFullYear() + now.getMonth() / 12 + 1 / 12 }
  }
  return { start, end: dateToDecimalYear(stage.endDate) }
}

/**
 * 事件不需要手动绑定阶段:
 * 只要事件时间落入阶段区间内,就自然归属于该阶段。
 * 若事件显式指定了 stageId,则同样视为归属(处理时间模糊的情况)。
 *
 * 注意:归属只用于计数与上下文标注(如阶段事件数、新建事件时的预填),
 * 不用于过滤事件列表。阶段是时间区间与导航上下文,不是事件筛选器。
 */
export function isEventInStage(event: LifeEvent, stage: LifeStage): boolean {
  if (event.stageId === stage.id) return true
  const { start, end } = stageRange(stage)
  const y = dateToDecimalYear(event.date)
  return y >= start && y <= end
}

/**
 * 判断某个时刻处于哪个人生阶段 —— 用于「拖动时间轴 → 顶部阶段自动高亮」。
 *
 * 阶段允许互相重叠(例如「大学」与「学习编程」可以同时进行),
 * 因此当多个阶段都覆盖该时刻时:
 * 1. 优先采用用户最近一次主动选择的阶段;
 * 2. 否则选择开始时间最接近该时刻的阶段。
 */
export function stageAtYear(
  stages: LifeStage[],
  year: number,
  preferredId?: string | null,
): LifeStage | null {
  const covering = stages.filter((stage) => {
    const { start, end } = stageRange(stage)
    return year >= start && year <= end
  })
  if (covering.length === 0) return null
  if (preferredId) {
    const preferred = covering.find((s) => s.id === preferredId)
    if (preferred) return preferred
  }
  return covering.reduce((best, stage) =>
    Math.abs(year - dateToDecimalYear(stage.startDate)) <
    Math.abs(year - dateToDecimalYear(best.startDate))
      ? stage
      : best,
  )
}

/** 用户阶段按开始时间从早到晚排序;开始时间相同则保持创建顺序 */
export function sortStages(stages: LifeStage[]): LifeStage[] {
  return stages
    .map((stage, index) => ({ stage, index }))
    .sort((a, b) => {
      const diff = dateToDecimalYear(a.stage.startDate) - dateToDecimalYear(b.stage.startDate)
      return diff !== 0 ? diff : a.index - b.index
    })
    .map(({ stage }) => stage)
}

/** 用于面板与说明文字的范围描述,如 "2015 年 9 月 — 2018 年 6 月"、"2024 年 9 月 — 至今" */
export function formatStageRange(stage: LifeStage): string {
  const end = stage.isOngoing ? '至今' : (stage.endDisplay ?? '未定')
  return `${stage.startDisplay} — ${end}`
}
