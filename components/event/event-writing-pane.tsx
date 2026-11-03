'use client'

// 同页写作区:选中人生节点后在原页面展开的正文
// 没有"阅读态 / 编辑态"之分,也没有保存按钮 —— 点进去就能继续写
// 正文实时写入;改动时间时保留局部草稿,确认后再调整记录位置。

import { useEffect, useRef, useState, type Ref } from 'react'
import type { LifeEvent } from '@/types/life-event'
import type { LifeStage } from '@/types/life-stage'
import { EventDateEditor } from './event-date-editor'
import { RichEditor, type RichEditorHandle } from '@/components/editor/rich-editor'
import { cn } from '@/lib/utils'

/** 正文首行与顶部可见底边之间恒定的呼吸间距(px) */
const WRITING_GAP = 40

interface EventWritingPaneProps {
  event: LifeEvent
  /** 该节点所处的人生阶段,仅作为正文上方的上下文标注 */
  stage: LifeStage | null
  /**
   * 今日记草稿态(§3):界面与真实记录完全一致,只有两点不同 ——
   * 光标自动落在正文(点「现在」就是为了写),以及更贴合"今天"的引导语。
   * 落地时这个标记会变成 false,但绝不重建 DOM,所以输入不会被打断。
   */
  isDraft?: boolean
  autoFocusDraft?: boolean
  /** 正文文档身份:草稿与它落地后的今日记共用同一个 docKey,编辑器因此不会重建 */
  docKey: string
  editorRef?: Ref<RichEditorHandle>
  /** 完全收拢后顶部时间轴仍占据的视口高度 */
  topInset: number
  /** 用于检查每日仅一篇日记的日期约束。 */
  events?: readonly LifeEvent[]
  onChange: (patch: Partial<LifeEvent>) => void
}

export function EventWritingPane({
  event,
  stage,
  isDraft = false,
  autoFocusDraft = true,
  docKey,
  editorRef,
  topInset,
  events = [],
  onChange,
}: EventWritingPaneProps) {
  const [editingTitle, setEditingTitle] = useState(false)
  const titleInputRef = useRef<HTMLInputElement>(null)

  // 切换到别的文档时收起所有轻量编辑态(草稿落地为今日记不算切换)
  useEffect(() => {
    setEditingTitle(false)
  }, [docKey])

  // 进入标题编辑后自动聚焦
  useEffect(() => {
    if (editingTitle) titleInputRef.current?.select()
  }, [editingTitle])

  return (
    <article
      /*
        这里刻意不写 key={event.id}:草稿落地成真实记录时 id 会变,
        若以此为 key 就会重建整棵子树 —— 正在输入的光标与输入法状态随之丢失。
        节点切换的重置改由上层 key 与 event.id 的 effect 负责。
      */
      /*
        paddingTop 是一个常量,这一点很关键:

        顶部 sticky 容器的布局高度恒定,收缩只由 transform 表达。因此在任意
        滚动位置 S,顶部可见底边落在 (H − S),正文首行落在 (H − S + GAP) ——
        两者间距恒为 GAP,过渡全程都不会遮挡。
        如果这里改成"实测顶部高度",就会变成
        改布局 → 重新测量 → 文档高度变化 → 浏览器夹紧 scrollY → 状态翻转,
        也就是之前上下抖动的根源。

        min-h-svh 则保证滚动区间始终够长,能真正滚到完全收缩的位置。

        opacity / translateY 读同一个滚动进度 --tl-p:时间轴收拢的同时正文
        轻微上浮并变实,让"视觉中心"从时间轴自然交接到正文。幅度刻意很小 ——
        正文是要被阅读和书写的,不该跟着晃。transform 不影响布局。
      */
      style={{
        paddingTop: WRITING_GAP,
        opacity: 'calc(0.85 + 0.15 * var(--tl-p, 0))',
        transform: 'translate3d(0, calc((1 - var(--tl-p, 0)) * 10px), 0)',
      }}
      className="lt-writing-pane animate-preview-in mx-auto flex min-h-svh w-full max-w-2xl flex-col px-6 pb-40 md:px-0"
    >
      {/* 时间 / 阶段上下文 */}
      <EventDateEditor key={docKey} event={event} stage={stage} events={events} onChange={onChange} />

      {/* 标题:默认就是标题的样子,点击后才变成输入 */}
      {editingTitle ? (
        <input
          ref={titleInputRef}
          type="text"
          value={event.title}
          onChange={(e) => onChange({ title: e.target.value })}
          onBlur={() => setEditingTitle(false)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return
            if (e.key === 'Enter' || e.key === 'Escape') setEditingTitle(false)
          }}
          aria-label="人生节点标题"
          className="mt-3 w-full border-b border-ring/60 bg-transparent pb-1 font-serif text-3xl leading-snug text-foreground outline-none md:text-4xl"
        />
      ) : (
        <h1
          tabIndex={0}
          role="button"
          onClick={() => setEditingTitle(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              setEditingTitle(true)
            }
          }}
          title="点击修改标题"
          className="mt-3 cursor-text border-b border-transparent pb-1 font-serif text-3xl leading-snug text-foreground text-balance transition-colors hover:border-border focus-visible:border-border focus-visible:outline-none md:text-4xl"
        >
          {event.title}
        </h1>
      )}

      {/* 重要程度:直接点圆点即可改,不需要进入表单 */}
      <div
        className="mt-5 flex items-center gap-1"
        role="radiogroup"
        aria-label="重要程度 1 到 5"
      >
        {[1, 2, 3, 4, 5].map((level) => (
          <button
            key={level}
            type="button"
            role="radio"
            aria-checked={event.importance === level}
            aria-label={`重要程度 ${level}`}
            onClick={() => onChange({ importance: level })}
            className="group flex size-6 items-center justify-center"
          >
            <span
              className={cn(
                'block rounded-full transition-all duration-200',
                // 用墨色而不是强调色:这是纸上的轻重之分,不是一个高亮控件
                level <= event.importance
                  ? 'bg-foreground/70'
                  : 'bg-border group-hover:bg-muted-foreground/40',
              )}
              style={{ width: 5 + level, height: 5 + level }}
            />
          </button>
        ))}
      </div>

      {/* 正文:文字、图片、附件按写作顺序混排,看起来是文章,而不是表单 */}
      <RichEditor
        diaryDate={/^\d{4}-\d{2}-\d{2}$/.test(event.date) ? event.date : undefined}
        ref={editorRef}
        docKey={docKey}
        richContent={event.richContent}
        plainContent={event.content}
        placeholder={isDraft ? '今天……' : '继续书写……'}
        autoFocus={isDraft && autoFocusDraft}
        topInset={topInset}
        onChange={onChange}
      />
    </article>
  )
}
