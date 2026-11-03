'use client'

// 新建 / 编辑人生阶段:右侧 Drawer
// 阶段 = 名称 + 类型(时间区间 / 从某时刻至今)+ 时间 + 说明

import { useEffect, useState } from 'react'
import { Trash2, X } from 'lucide-react'
import type { LifeStage, StageType } from '@/types/life-stage'
import { FuzzyDateInput, type FuzzyDateValue } from '@/components/event/fuzzy-date-input'
import { Overlay } from '@/components/common/overlay'
import { cn } from '@/lib/utils'

interface StageEditorDrawerProps {
  open: boolean
  /** 传入阶段为编辑模式,null 为新建模式 */
  stage: LifeStage | null
  onClose: () => void
  onSubmit: (value: Omit<LifeStage, 'id'>) => void
  onDelete?: (id: string) => void
}

const fieldLabel = 'text-xs font-medium tracking-wide text-muted-foreground'

const DEFAULT_START: FuzzyDateValue = {
  date: '2020',
  displayDate: '2020 年',
  datePrecision: 'year',
}
const DEFAULT_END: FuzzyDateValue = {
  date: '2023',
  displayDate: '2023 年',
  datePrecision: 'year',
}

const STAGE_TYPES: Array<{ value: StageType; label: string; hint: string }> = [
  { value: 'range', label: '时间区间', hint: '从某个开始时间,到某个结束时间' },
  { value: 'ongoing', label: '从某时刻到至今', hint: '从某个时间点开始,一直持续到现在' },
]

export function StageEditorDrawer({
  open,
  stage,
  onClose,
  onSubmit,
  onDelete,
}: StageEditorDrawerProps) {
  const editing = stage !== null

  const [name, setName] = useState('')
  const [type, setType] = useState<StageType>('range')
  const [start, setStart] = useState<FuzzyDateValue>(DEFAULT_START)
  const [end, setEnd] = useState<FuzzyDateValue>(DEFAULT_END)
  const [description, setDescription] = useState('')

  // 打开时载入 / 重置表单
  useEffect(() => {
    if (!open) return
    if (stage) {
      setName(stage.name)
      setType(stage.type)
      setStart({
        date: stage.startDate,
        displayDate: stage.startDisplay,
        datePrecision: stage.startPrecision,
      })
      setEnd(
        stage.endDate
          ? {
              date: stage.endDate,
              displayDate: stage.endDisplay ?? '',
              datePrecision: stage.endPrecision ?? 'year',
            }
          : DEFAULT_END,
      )
      setDescription(stage.description ?? '')
    } else {
      setName('')
      setType('range')
      setStart(DEFAULT_START)
      setEnd(DEFAULT_END)
      setDescription('')
    }
  }, [open, stage])

  const canSubmit = name.trim().length > 0

  const handleSubmit = () => {
    if (!canSubmit) return
    const isOngoing = type === 'ongoing'
    onSubmit({
      name: name.trim(),
      type,
      startDate: start.date,
      startDisplay: start.displayDate,
      startPrecision: start.datePrecision,
      endDate: isOngoing ? null : end.date,
      endDisplay: isOngoing ? null : end.displayDate,
      endPrecision: isOngoing ? null : end.datePrecision,
      isOngoing,
      description: description.trim() || undefined,
    })
    onClose()
  }

  return (
    <Overlay
      open={open}
      onClose={onClose}
      align="right"
      label={editing ? '编辑人生阶段' : '新建人生阶段'}
    >
      <div className="flex h-full w-[26rem] max-w-[92vw] flex-col bg-background shadow-xl">
        <header className="flex items-center justify-between border-b border-border/70 px-6 py-4">
          <h2 className="font-serif text-lg text-foreground">
            {editing ? '编辑人生阶段' : '新建人生阶段'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="关闭"
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="flex flex-1 flex-col gap-7 overflow-y-auto px-6 py-6">
          {/* 阶段名称 */}
          <div className="flex flex-col gap-2">
            <label htmlFor="stage-name" className={fieldLabel}>
              这段时间,你想叫它什么?
            </label>
            <input
              id="stage-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如:独处时期 / 和某人有关的那几年"
              autoFocus
              className="w-full border-b border-input bg-transparent pb-2 font-serif text-xl text-foreground outline-none transition-colors placeholder:text-muted-foreground/50 focus:border-ring"
            />
          </div>

          {/* 阶段类型 */}
          <div className="flex flex-col gap-2">
            <span className={fieldLabel}>这段时间是</span>
            <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="阶段类型">
              {STAGE_TYPES.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={type === option.value}
                  onClick={() => setType(option.value)}
                  className={cn(
                    'flex flex-col items-start gap-0.5 rounded-md border px-3 py-2.5 text-left transition-colors',
                    type === option.value
                      ? 'border-primary/60 bg-muted/70'
                      : 'border-border hover:border-foreground/30',
                  )}
                >
                  <span
                    className={cn(
                      'text-sm',
                      type === option.value ? 'text-foreground' : 'text-muted-foreground',
                    )}
                  >
                    {option.label}
                  </span>
                  <span className="text-xs leading-snug text-muted-foreground/70">
                    {option.hint}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* 开始时间 */}
          <div className="flex flex-col gap-2">
            <span className={fieldLabel}>从什么时候开始?</span>
            <FuzzyDateInput value={start} onChange={setStart} />
          </div>

          {/* 结束时间:仅时间区间模式 */}
          {type === 'range' ? (
            <div className="flex flex-col gap-2">
              <span className={fieldLabel}>到什么时候结束?</span>
              <FuzzyDateInput value={end} onChange={setEnd} />
            </div>
          ) : (
            <p className="rounded-md border border-dashed border-border px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
              这个阶段会一直延伸到现在,不需要填写结束时间。
            </p>
          )}

          {/* 阶段说明 */}
          <div className="flex flex-col gap-2">
            <label htmlFor="stage-description" className={fieldLabel}>
              想为这段时间写一句话吗?(可选)
            </label>
            <textarea
              id="stage-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="例如:那几年主要在适应环境"
              className="w-full resize-none rounded-md border border-input bg-background px-3 py-2.5 font-serif text-sm leading-relaxed text-foreground outline-none transition-colors placeholder:text-muted-foreground/50 focus:border-ring focus:ring-2 focus:ring-ring/30"
            />
          </div>
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-border/70 px-6 py-4">
          {editing && onDelete && stage ? (
            <button
              type="button"
              onClick={() => {
                onDelete(stage.id)
                onClose()
              }}
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-2 text-sm text-muted-foreground/70 transition-colors hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 className="size-3.5" />
              删除阶段
            </button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-4 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              取消
            </button>
            <button
              type="button"
              disabled={!canSubmit}
              onClick={handleSubmit}
              className="rounded-md bg-primary px-5 py-2 text-sm text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {editing ? '保存阶段' : '创建阶段'}
            </button>
          </div>
        </footer>
      </div>
    </Overlay>
  )
}
