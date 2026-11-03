'use client'

// 人生阶段按钮行 —— 快速定位锚点,不是筛选器
// 普通状态:点击 = 把完整时间轴平滑移动到该阶段所在的时间段
// 高亮状态由时间轴视口中心反向驱动(拖动时间轴 → 顶部自动切换)
// 管理状态(长按 / 右键任一用户阶段进入):点击 = 编辑该阶段,行尾出现"+ 新建"
// "全部"是系统按钮:永远第一、不可编辑 / 删除 / 重命名,作用是缩放回人生全局视图

import { useCallback, useEffect, useRef } from 'react'
import { Check, Plus } from 'lucide-react'
import { ALL_STAGE_ID, ALL_STAGE_NAME, type LifeStage } from '@/types/life-stage'
import { cn } from '@/lib/utils'

const LONG_PRESS_MS = 500

interface LifeStageNavProps {
  stages: LifeStage[]
  activeStageId: string
  /** 各阶段范围内的事件数量,用于弱提示空阶段 */
  stageCounts: Map<string, number>
  managing: boolean
  onSelectStage: (id: string) => void
  onEnterManaging: () => void
  onExitManaging: () => void
  onEditStage: (stage: LifeStage) => void
  onCreateStage: () => void
}

export function LifeStageNav({
  stages,
  activeStageId,
  stageCounts,
  managing,
  onSelectStage,
  onEnterManaging,
  onExitManaging,
  onEditStage,
  onCreateStage,
}: LifeStageNavProps) {
  const timerRef = useRef<number | null>(null)
  const longPressedRef = useRef(false)
  const navRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLElement>(null)

  // 阶段可能很多,当前阶段(含被拖动时间轴切换出来的)始终自动滚入可见区
  useEffect(() => {
    const list = listRef.current
    const active = list?.querySelector<HTMLElement>('[data-stage-active="true"]')
    if (!list || !active) return
    const listBox = list.getBoundingClientRect()
    const box = active.getBoundingClientRect()
    if (box.left < listBox.left + 8) {
      list.scrollBy({ left: box.left - listBox.left - 24, behavior: 'smooth' })
    } else if (box.right > listBox.right - 8) {
      list.scrollBy({ left: box.right - listBox.right + 24, behavior: 'smooth' })
    }
  }, [activeStageId])

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  // 管理模式:Esc 或点击页面其他区域退出
  useEffect(() => {
    if (!managing) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onExitManaging()
    }
    const onPointerDown = (e: PointerEvent) => {
      if (!navRef.current?.contains(e.target as Node)) onExitManaging()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [managing, onExitManaging])

  useEffect(() => clearTimer, [clearTimer])

  const handlePointerDown = useCallback(() => {
    if (managing) return
    longPressedRef.current = false
    clearTimer()
    timerRef.current = window.setTimeout(() => {
      longPressedRef.current = true
      onEnterManaging()
    }, LONG_PRESS_MS)
  }, [managing, clearTimer, onEnterManaging])

  const handleClick = useCallback(
    (stage: LifeStage) => {
      clearTimer()
      // 长按刚刚触发过管理模式,本次 click 不再执行定位
      if (longPressedRef.current) {
        longPressedRef.current = false
        return
      }
      if (managing) onEditStage(stage)
      else onSelectStage(stage.id)
    },
    [managing, clearTimer, onEditStage, onSelectStage],
  )

  const allActive = activeStageId === ALL_STAGE_ID

  return (
    <div ref={navRef} className="flex items-center gap-2">
      <nav
        ref={listRef}
        aria-label="人生阶段"
        className="timeline-scroll flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
      >
        {/* 系统阶段:全部 —— 缩放回人生全局视图 */}
        <button
          type="button"
          onClick={() => onSelectStage(ALL_STAGE_ID)}
          data-stage-active={allActive ? 'true' : undefined}
          aria-current={allActive ? 'true' : undefined}
          title="回到人生全局视图"
          className={cn(
            'relative shrink-0 rounded-md px-3 py-1.5 text-sm transition-colors',
            allActive ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
            managing && 'opacity-40',
          )}
        >
          {ALL_STAGE_NAME}
          <span
            aria-hidden="true"
            className={cn(
              'absolute inset-x-3 bottom-0 h-px bg-primary transition-opacity duration-200',
              allActive ? 'opacity-100' : 'opacity-0',
            )}
          />
        </button>

        {/* 用户创建的阶段 */}
        {stages.map((stage) => {
          const active = activeStageId === stage.id
          const empty = (stageCounts.get(stage.id) ?? 0) === 0
          return (
            <button
              key={stage.id}
              type="button"
              onPointerDown={handlePointerDown}
              onPointerUp={clearTimer}
              onPointerLeave={clearTimer}
              onContextMenu={(e) => {
                e.preventDefault()
                if (managing) onEditStage(stage)
                else onEnterManaging()
              }}
              onClick={() => handleClick(stage)}
              data-stage-active={active ? 'true' : undefined}
              aria-current={active && !managing ? 'true' : undefined}
              title={managing ? `编辑「${stage.name}」` : `移动到「${stage.name}」`}
              className={cn(
                'relative shrink-0 rounded-md px-3 py-1.5 text-sm transition-colors',
                managing
                  ? 'text-foreground/80 hover:bg-muted hover:text-foreground'
                  : active
                    ? 'text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                !managing && empty && !active && 'opacity-45',
                managing && 'ring-1 ring-border ring-inset',
              )}
            >
              {stage.name}
              {/* 持续至今:一个极小的空心点,避免被误读为文字截断 */}
              {stage.isOngoing && (
                <span
                  title="持续至今"
                  className="ml-1.5 inline-block size-[3px] translate-y-[-3px] rounded-full border border-current align-middle opacity-50"
                >
                  <span className="sr-only">持续至今</span>
                </span>
              )}
              <span
                aria-hidden="true"
                className={cn(
                  'absolute inset-x-3 bottom-0 h-px bg-primary transition-opacity duration-200',
                  active && !managing ? 'opacity-100' : 'opacity-0',
                )}
              />
            </button>
          )
        })}

        {/* 管理模式:行尾新建入口 */}
        {managing && (
          <button
            type="button"
            onClick={onCreateStage}
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-dashed border-border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground"
          >
            <Plus className="size-3.5" />
            新建
          </button>
        )}
      </nav>

      {/* 管理入口 / 退出:克制但可被发现,避免长按成为唯一入口 */}
      {managing ? (
        <button
          type="button"
          onClick={onExitManaging}
          className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Check className="size-3.5" />
          完成
        </button>
      ) : (
        stages.length > 0 && (
          <button
            type="button"
            onClick={onEnterManaging}
            title="管理人生阶段(也可长按或右键阶段)"
            className="shrink-0 rounded-md px-2 py-1.5 text-xs text-muted-foreground/45 transition-colors hover:bg-muted hover:text-muted-foreground"
          >
            管理阶段
          </button>
        )
      )}
    </div>
  )
}
