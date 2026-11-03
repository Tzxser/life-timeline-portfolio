'use client'

// 新建人生节点:右侧 Drawer,填写标题 / 模糊时间 / 可选阶段 / 简单内容
// 事件首先是一个时间点,人生阶段只是辅助上下文,可以不选

import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import type { LifeEvent } from '@/types/life-event'
import { formatStageRange, type LifeStage } from '@/types/life-stage'
import { FuzzyDateInput, type FuzzyDateValue } from './fuzzy-date-input'
import { Overlay } from '@/components/common/overlay'
import { cn } from '@/lib/utils'

interface CreateEventDrawerProps {
  open: boolean
  stages: LifeStage[]
  /** 当前视野正落在某个阶段区间内时,预填该阶段作为上下文 */
  presetStage: LifeStage | null
  onClose: () => void
  onCreate: (event: Omit<LifeEvent, 'id'>) => void
}

const fieldLabel = 'text-xs font-medium tracking-wide text-muted-foreground'

const DEFAULT_DATE: FuzzyDateValue = { date: '2020', displayDate: '2020 年', datePrecision: 'year' }

/** 阶段范围内的一个合理默认时间:优先落在阶段开始处 */
function dateFromStage(stage: LifeStage): FuzzyDateValue {
  return {
    date: stage.startDate,
    displayDate: stage.startDisplay,
    datePrecision: stage.startPrecision,
  }
}

export function CreateEventDrawer({
  open,
  stages,
  presetStage,
  onClose,
  onCreate,
}: CreateEventDrawerProps) {
  const [title, setTitle] = useState('')
  const [dateValue, setDateValue] = useState<FuzzyDateValue>(DEFAULT_DATE)
  const [stageId, setStageId] = useState<string | null>(null)
  const [content, setContent] = useState('')

  // 每次打开时重置表单,并预填当前所选人生阶段
  useEffect(() => {
    if (open) {
      setTitle('')
      setDateValue(presetStage ? dateFromStage(presetStage) : DEFAULT_DATE)
      setStageId(presetStage?.id ?? null)
      setContent('')
    }
  }, [open, presetStage])

  const canCreate = title.trim().length > 0

  const handleCreate = () => {
    if (!canCreate) return
    onCreate({
      title: title.trim(),
      date: dateValue.date,
      displayDate: dateValue.displayDate,
      datePrecision: dateValue.datePrecision,
      stageId,
      importance: 3,
      summary: content.trim().split('\n')[0]?.slice(0, 60) || '一段新的人生记录。',
      content: content.trim() || '这里还没有写下内容。',
    })
    onClose()
  }

  return (
    <Overlay open={open} onClose={onClose} align="right" label="新建人生节点">
      <div className="flex h-full w-[26rem] max-w-[92vw] flex-col bg-background shadow-xl">
        <header className="flex items-center justify-between border-b border-border/70 px-6 py-4">
          <h2 className="font-serif text-lg text-foreground">新建人生节点</h2>
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
          <div className="flex flex-col gap-2">
            <label htmlFor="create-title" className={fieldLabel}>
              发生了什么?
            </label>
            <input
              id="create-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="例如:第一次一个人旅行"
              autoFocus
              className="w-full border-b border-input bg-transparent pb-2 font-serif text-xl text-foreground outline-none transition-colors placeholder:text-muted-foreground/50 focus:border-ring"
            />
          </div>

          <div className="flex flex-col gap-2">
            <span className={fieldLabel}>大概什么时候?</span>
            <FuzzyDateInput value={dateValue} onChange={setDateValue} />
          </div>

          {/* 可选阶段:展示当前已创建的人生阶段 */}
          <div className="flex flex-col gap-2">
            <span className={fieldLabel}>属于哪个人生阶段?(可选)</span>
            {stages.length === 0 ? (
              <p className="rounded-md border border-dashed border-border px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
                你还没有创建人生阶段。可以先记下这件事,之后再把它归入某段时间。
              </p>
            ) : (
              <>
                <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="人生阶段">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={stageId === null}
                    onClick={() => setStageId(null)}
                    className={cn(
                      'rounded-full border px-3 py-1 text-xs transition-colors',
                      stageId === null
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-border text-muted-foreground hover:border-foreground/40 hover:text-foreground',
                    )}
                  >
                    不指定
                  </button>
                  {stages.map((stage) => (
                    <button
                      key={stage.id}
                      type="button"
                      role="radio"
                      aria-checked={stageId === stage.id}
                      onClick={() => setStageId(stage.id)}
                      title={formatStageRange(stage)}
                      className={cn(
                        'rounded-full border px-3 py-1 text-xs transition-colors',
                        stageId === stage.id
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border text-muted-foreground hover:border-foreground/40 hover:text-foreground',
                      )}
                    >
                      {stage.name}
                    </button>
                  ))}
                </div>
                <p className="text-xs leading-snug text-muted-foreground/70">
                  不选也没关系,事件会按时间自然落进对应的阶段。
                </p>
              </>
            )}
          </div>

          <div className="flex flex-1 flex-col gap-2">
            <label htmlFor="create-content" className={fieldLabel}>
              想先写几句吗?(可选)
            </label>
            <textarea
              id="create-content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={6}
              placeholder="随手记下几句,之后可以在详情里慢慢补充……"
              className="w-full flex-1 resize-none rounded-md border border-input bg-background px-3 py-2.5 font-serif text-sm leading-relaxed text-foreground outline-none transition-colors placeholder:text-muted-foreground/50 focus:border-ring focus:ring-2 focus:ring-ring/30"
            />
          </div>
        </div>

        <footer className="flex items-center justify-end gap-3 border-t border-border/70 px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-4 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            取消
          </button>
          <button
            type="button"
            disabled={!canCreate}
            onClick={handleCreate}
            className="rounded-md bg-primary px-5 py-2 text-sm text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            创建节点
          </button>
        </footer>
      </div>
    </Overlay>
  )
}
