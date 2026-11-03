'use client'

// 同页图文编辑器
//
// 文字、图片、附件按写作顺序处于同一篇正文里。几个必须守住的点:
//
//   · 编辑器实例只创建一次。切换记录时换的是“文档”,不是组件 ——
//     每篇文档的 EditorState(含撤销历史)按 docKey 分别缓存,
//     A → B → A 回来时 A 的撤销历史仍在,也不会把 B 的内容撤销成 A。
//   · 自己 onUpdate 写回 store 后,绝不再反向 setContent —— 否则光标跳动、撤销清空。
//   · 草稿 → 今日记落地时 docKey 不变,编辑器、选区与输入法状态原样保留。
//   · 文件插入批次绑定发起时的 docKey;读取结束时若已换了记录,整批取消,不会落到别处。

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Placeholder } from '@tiptap/extensions'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import { getMarkRange } from '@tiptap/react'
import { Bold, ImagePlus, Link2, List, Paperclip, Redo2, Undo2 } from 'lucide-react'
import type { RichContent } from '@/types/life-event'
import {
  ATTACHMENT_NODE,
  IMAGE_LINK_MARK,
  IMAGE_NODE,
  collectAttachmentIds,
  plainTextToDoc,
  toRichContent,
} from '@/lib/rich-content'
import {
  ATTACHMENT_LIMITS,
  commitFile,
  formatBytes,
  inspectFiles,
} from '@/lib/session-attachments'
import { LifeImage } from './image-node'
import { LifeAttachment } from './attachment-node'
import { ImageLink, ImageLinkOverlay, imageIdsInDoc } from './image-links'
import { EditorMenu, type MenuRequest } from './editor-menu'
import { cn } from '@/lib/utils'
import { useLifeStore } from '@/lib/life-store'
import { LifeSchedule } from '@/components/schedules/schedule-node'
import { SchedulePicker } from '@/components/schedules/schedule-picker'
import { ScheduleManager } from '@/components/schedules/schedule-manager'
import { SCHEDULE_NODE } from '@/lib/schedules/model'
import { CalendarDays } from 'lucide-react'
import { waitForComposition } from '@/lib/editor-composition'

export interface RichEditorChange {
  richContent: RichContent
  content: string
  attachmentIds: string[]
}

export interface RichEditorHandle {
  /**
   * 主动切换记录前调用:若输入法仍在合成,先安全结束合成,
   * 并等 ProseMirror 把最后一个字读回当前文档后再返回。
   */
  settle: () => Promise<void>
}

interface RichEditorProps {
  diaryDate?: string
  /** 文档身份。只有它变化才算“换了一篇”;草稿落地为今日记时保持不变 */
  docKey: string
  richContent: RichContent | undefined
  plainContent: string
  placeholder: string
  autoFocus: boolean
  /** 写作状态下顶部时间轴占据的视口高度(px),用于光标滚动定位 */
  topInset: number
  onChange: (change: RichEditorChange) => void
}

type Status = { tone: 'info' | 'busy' | 'warn'; text: string; details?: string[] } | null

const IMAGE_ACCEPT = 'image/*'
/** 吸附工具栏的高度(py-2 + h-8 + 细线) */
const TOOLBAR_HEIGHT = 49

function initialDoc(richContent: RichContent | undefined, plainContent: string) {
  return richContent?.doc ?? plainTextToDoc(plainContent)
}

export const RichEditor = forwardRef<RichEditorHandle, RichEditorProps>(function RichEditor(
  { docKey, richContent, plainContent, placeholder, autoFocus, topInset, onChange, diaryDate },
  ref,
) {
  const { platformKind, persistenceStatus } = useLifeStore()
  /* 最新的 props 放进 ref:编辑器回调只创建一次,但永远读到当前值 */
  const latest = useRef({ docKey, richContent, plainContent, placeholder, onChange })
  /** 编辑器当前承载的文档;与 props.docKey 不同即说明需要换文档 */
  const mountedKeyRef = useRef(docKey)
  /**
   * 写回函数绑定到“编辑器里实际载入的那篇文档”,而不是最新的 props。
   * 换文档的那一瞬间若有迟到的更新(例如输入法最后一个字),它只会写回原来那篇。
   */
  const mountedOnChangeRef = useRef(onChange)
  useLayoutEffect(() => {
    latest.current = { docKey, richContent, plainContent, placeholder, onChange }
    if (docKey === mountedKeyRef.current) mountedOnChangeRef.current = onChange
  })
  /** 本编辑器最近一次写回 store 的正文对象 —— 用来判断缓存的状态是否仍是最新 */
  const lastEmittedRef = useRef<RichContent | undefined>(richContent)
  const stateCacheRef = useRef(new Map<string, { state: EditorState; rc: RichContent | undefined }>())
  const hadFocusRef = useRef(false)
  const compositionEndedAtRef = useRef(0)
  /** Monotonic editor document revision used to avoid stale numeric insert positions. */
  const docRevisionRef = useRef(0)
  const insertFilesRef = useRef<(files: File[], at: number | null) => void>(() => {})

  const [menu, setMenu] = useState<MenuRequest | null>(null)
  const [schedulePickerKey, setSchedulePickerKey] = useState<string | null>(null)
  const [scheduleManager, setScheduleManager] = useState(false)
  const [contentEl, setContentEl] = useState<HTMLDivElement | null>(null)
  const [status, setStatus] = useState<Status>(null)
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const showStatus = useCallback((next: Status, autoClearMs?: number) => {
    if (statusTimer.current) clearTimeout(statusTimer.current)
    setStatus(next)
    if (autoClearMs) statusTimer.current = setTimeout(() => setStatus(null), autoClearMs)
  }, [])
  useEffect(
    () => () => {
      if (statusTimer.current) clearTimeout(statusTimer.current)
    },
    [],
  )

  const emit = useCallback((editor: Editor) => {
    docRevisionRef.current += 1
    const doc = editor.getJSON()
    const rc = toRichContent(doc)
    lastEmittedRef.current = rc
    mountedOnChangeRef.current({
      richContent: rc,
      content: editor.getText({ blockSeparator: '\n' }),
      attachmentIds: collectAttachmentIds(doc),
    })
  }, [])

  const editor = useEditor({
    // Next.js 下由客户端创建,避免 SSR 与首帧内容不一致导致的 hydration 错误
    immediatelyRender: false,
    shouldRerenderOnTransaction: false,
    extensions: [
      StarterKit.configure({
        heading: false,
        blockquote: false,
        code: false,
        codeBlock: false,
        horizontalRule: false,
        strike: false,
        underline: false,
        // 不自动识别链接:粘贴的网址只是文字,不会变成可点击的远程引用
        link: false,
        dropcursor: { color: 'var(--ring)', width: 2 },
      }),
      Placeholder.configure({ placeholder: () => latest.current.placeholder }),
      LifeImage.configure({ requestMenu: (request) => setMenu(request) }),
      LifeAttachment,
      LifeSchedule,
      ImageLink,
    ],
    content: initialDoc(richContent, plainContent),
    editorProps: {
      attributes: {
        class: 'lt-editor',
        'aria-label': '正文',
        'aria-multiline': 'true',
        role: 'textbox',
      },
      handlePaste: (view, event) => {
        const files = Array.from(event.clipboardData?.files ?? [])
        if (files.length === 0) return false
        // 带文字的剪贴板(例如从 Word 复制的一段话)按普通文字粘贴,不插入它附带的截图
        const text = event.clipboardData?.getData('text/plain') ?? ''
        if (text.trim() !== '') return false
        event.preventDefault()
        insertFilesRef.current(files, view.state.selection.from)
        return true
      },
      handleDrop: (view, event, _slice, moved) => {
        if (moved) return false
        const files = Array.from(event.dataTransfer?.files ?? [])
        if (files.length === 0) return false
        event.preventDefault()
        const coords = view.posAtCoords({ left: event.clientX, top: event.clientY })
        insertFilesRef.current(files, coords ? coords.pos : null)
        return true
      },
      handleDOMEvents: {
        /* 只在“选中的文字上”或“已关联的文字上”接管右键;其余位置保留浏览器菜单。
           图片的右键由图片节点自己处理。 */
        contextmenu: (view, event) => {
          if (event.shiftKey) return false
          const target = event.target instanceof Element ? event.target : null
          if (!target || target.closest('[data-node-view-wrapper]')) return false
          const { state } = view
          const { selection } = state
          let range: { from: number; to: number } | null = null

          const hit = view.posAtCoords({ left: event.clientX, top: event.clientY })
          if (
            selection instanceof TextSelection &&
            !selection.empty &&
            hit &&
            hit.pos >= selection.from &&
            hit.pos <= selection.to &&
            state.doc.textBetween(selection.from, selection.to).trim() !== ''
          ) {
            range = { from: selection.from, to: selection.to }
          }
          const linkEl = target.closest('[data-image-link]')
          if (!range && linkEl) {
            const markType = state.schema.marks[IMAGE_LINK_MARK]
            const start = view.posAtDOM(linkEl, 0)
            const markRange = markType ? getMarkRange(state.doc.resolve(start), markType) : undefined
            if (markRange) range = markRange
          }
          if (!range) return false
          event.preventDefault()
          setMenu({ kind: 'text', x: event.clientX, y: event.clientY, range })
          return true
        },
        compositionend: () => {
          compositionEndedAtRef.current = Date.now()
          return false
        },
      },
    },
    onUpdate: ({ editor }) => emit(editor),
    onFocus: () => {
      hadFocusRef.current = true
    },
  })

  /* ── 换文档:缓存旧文档的完整状态(含撤销历史),载入新文档 ─────────
     放在微任务里执行:重建图片 / 附件节点视图时 Tiptap 会同步渲染 React,
     不能发生在 React 的提交阶段内。微任务仍早于浏览器绘制,不会出现闪烁。 */
  const syncDocument = useCallback(() => {
    if (!editor || editor.isDestroyed) return
    const { docKey: targetKey, richContent: rc, plainContent: text, onChange: targetOnChange } =
      latest.current
    if (mountedKeyRef.current === targetKey) return

    const cache = stateCacheRef.current
    cache.set(mountedKeyRef.current, { state: editor.state, rc: lastEmittedRef.current })

    const cached = cache.get(targetKey)
    let nextState: EditorState
    if (cached && rc !== undefined && cached.rc === rc) {
      nextState = cached.state
    } else {
      let doc
      try {
        doc = editor.schema.nodeFromJSON(initialDoc(rc, text))
      } catch {
        doc = editor.schema.nodeFromJSON(plainTextToDoc(text))
      }
      // 沿用同一组插件:ProseMirror 会保留插件视图,只重建文档与历史
      nextState = EditorState.create({ doc, plugins: editor.state.plugins })
    }

    mountedKeyRef.current = targetKey
    mountedOnChangeRef.current = targetOnChange
    lastEmittedRef.current = rc
    hadFocusRef.current = false
    editor.view.updateState(nextState)
    // 通知工具栏刷新撤销 / 重做可用状态(不改文档、不进历史)
    editor.view.dispatch(editor.state.tr.setMeta('addToHistory', false))
    // 菜单里记着的是旧文档的位置,换文档时一并关闭
    setMenu(null)
    showStatus(null)
  }, [editor, showStatus])

  useLayoutEffect(() => {
    if (!editor || mountedKeyRef.current === docKey) return
    queueMicrotask(syncDocument)
  }, [editor, docKey, syncDocument])

  /* 顶部吸附的时间轴会盖住视口上方一段。告诉 ProseMirror 这段高度,
     插入、撤销、换行时光标就会停在时间轴下方可见处,而不是被滚到它背后。 */
  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    // 再加上吸附工具栏的高度,光标不会停在工具栏背后
    const top = Math.max(0, Math.round(topInset)) + TOOLBAR_HEIGHT
    editor.view.setProps({
      scrollThreshold: { top: top + 16, bottom: 48, left: 0, right: 0 },
      scrollMargin: { top: top + 40, bottom: 96, left: 0, right: 0 },
    })
  }, [editor, topInset])

  /* 草稿一出现就把光标放进正文:点「现在」的意图就是开始写今天 */
  const autoFocusedRef = useRef(false)
  useEffect(() => {
    if (!editor) return
    if (autoFocus && !autoFocusedRef.current) {
      autoFocusedRef.current = true
      editor.commands.focus('end', { scrollIntoView: false })
    }
    if (!autoFocus) autoFocusedRef.current = false
  }, [editor, autoFocus])

  /* ── 插入文件 ─────────────────────────────────────────── */
  const insertFiles = useCallback(
    async (files: File[], at: number | null) => {
      if (!editor || files.length === 0) return
      const batchKey = mountedKeyRef.current
      const batchRevision = docRevisionRef.current
      const isBatchCurrent = () =>
        !editor.isDestroyed &&
        mountedKeyRef.current === batchKey &&
        latest.current.docKey === batchKey
      showStatus({ tone: 'busy', text: `正在读取 ${files.length} 个文件……` })

      const results = await inspectFiles(files)

      if (!isBatchCurrent()) {
        showStatus({ tone: 'warn', text: '读取期间已切换到其他记录,本次插入已取消,两篇记录都未改动。' }, 8000)
        return
      }

      const nodes: Record<string, unknown>[] = []
      const failures: string[] = []
      const notes: string[] = []
      for (const result of results) {
        if (!isBatchCurrent()) {
          showStatus({ tone: 'warn', text: '读取期间已切换到其他记录,本次插入已取消,两篇记录都未改动。' }, 8000)
          return
        }
        if (!result.ok) {
          failures.push(`${result.name}:${result.reason}`)
          continue
        }
        const meta = await commitFile(result, {
          docKey: batchKey,
          isCurrent: isBatchCurrent,
        })
        if (!isBatchCurrent()) {
          showStatus({ tone: 'warn', text: '保存附件期间已切换到其他记录,本次插入已取消。' }, 8000)
          return
        }
        if (!meta) {
          failures.push(`${result.file.name}:本次会话的附件合计已达上限`)
          continue
        }
        if (meta.kind === 'image') {
          nodes.push({
            type: IMAGE_NODE,
            attrs: {
              attachmentId: meta.id,
              name: meta.name,
              caption: '',
              width: null,
              naturalWidth: meta.width ?? null,
              naturalHeight: meta.height ?? null,
            },
          })
        } else {
          nodes.push({
            type: ATTACHMENT_NODE,
            attrs: {
              attachmentId: meta.id,
              name: meta.name,
              mimeType: meta.mimeType,
              byteSize: meta.byteSize,
              note: result.note ?? null,
            },
          })
          if (result.note) notes.push(`${meta.name}:${result.note}`)
        }
      }

      if (!isBatchCurrent()) {
        showStatus({ tone: 'warn', text: '保存附件期间已切换到其他记录,本次插入已取消。' }, 8000)
        return
      }

      if (nodes.length > 0) {
        const { doc } = editor.state
        let target: number
        if (docRevisionRef.current !== batchRevision) {
          // The document changed while files were being copied.  The old
          // numeric offset no longer identifies the same paragraph; continue
          // at the current selection instead of inserting into a stale node.
          target = Math.min(Math.max(editor.state.selection.from, 0), doc.content.size)
        } else if (at !== null) {
          target = Math.min(Math.max(at, 0), doc.content.size)
        } else {
          // 没有有效光标:追加到正文末尾(落在最后一个段落里,空段落会被直接替换)
          const last = doc.lastChild
          target = last && last.isTextblock ? doc.content.size - 1 : doc.content.size
        }
        // 整批作为一次插入:一步撤销即可整体撤回
        editor
          .chain()
          .insertContentAt(target, nodes)
          .command(({ tr, state }) => {
            /* 光标必须落在插入内容“之后”的文字段落里。
               不能交给 Selection.near:后面没有段落时它会选中刚插入的图片,
               下一次输入或粘贴就会把图片替换掉;也不能靠位置映射推算 ——
               插在段落末尾时映射会落回前一段。直接找到最后插入的那个节点。 */
            const lastId = (nodes[nodes.length - 1].attrs as { attachmentId: string }).attachmentId
            let end = -1
            tr.doc.descendants((node, pos) => {
              if (end !== -1) return false
              if (node.attrs.attachmentId === lastId) {
                end = pos + node.nodeSize
                return false
              }
              return true
            })
            if (end === -1) return true
            const $end = tr.doc.resolve(end)
            if ($end.nodeAfter?.isTextblock) {
              tr.setSelection(TextSelection.create(tr.doc, end + 1))
            } else {
              tr.insert(end, state.schema.nodes.paragraph.create())
              tr.setSelection(TextSelection.create(tr.doc, end + 1))
            }
            return true
          })
          .focus(undefined, { scrollIntoView: true })
          .run()
      }

      const details = [...failures, ...notes]
      if (nodes.length > 0) {
        showStatus(
          {
            tone: failures.length ? 'warn' : 'info',
            text: `已添加 ${nodes.length} 项到当前记录(本次会话)${failures.length ? `,${failures.length} 项未能添加` : ''}`,
            details: details.length ? details : undefined,
          },
          failures.length ? undefined : 5000,
        )
      } else {
        showStatus({ tone: 'warn', text: '没有文件被添加,正文未改动。', details })
      }
    },
    [editor, showStatus],
  )
  useEffect(() => {
    insertFilesRef.current = (files, at) => void insertFiles(files, at)
  }, [insertFiles])

  useImperativeHandle(
    ref,
    () => ({
      settle: async () => {
        if (!editor || editor.isDestroyed) return
        const { view } = editor
        if (view.composing) (view.dom as HTMLElement).blur()
        await waitForComposition({ isComposing: () => view.composing, endedAt: () => compositionEndedAtRef.current })
      },
    }),
    [editor],
  )

  /* ── 文件选择器 ─────────────────────────────────────── */
  const imageInputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const pickerPosRef = useRef<number | null>(null)

  const openPicker = (input: HTMLInputElement | null) => {
    if (!editor || !input) return
    // 记住打开选择器前的编辑位置;从未进入过正文则追加到末尾
    pickerPosRef.current = hadFocusRef.current ? editor.state.selection.from : null
    input.click()
  }

  const onPicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    e.target.value = '' // 允许再次选择同一个文件
    if (files.length === 0) return // 取消选择:什么都不发生,也不会建出空记录
    void insertFiles(files, pickerPosRef.current)
  }

  const toolbar = useEditorState({
    editor,
    selector: ({ editor: ed }) => ({
      canUndo: ed ? ed.can().undo() : false,
      canRedo: ed ? ed.can().redo() : false,
      bold: ed ? ed.isActive('bold') : false,
      bulletList: ed ? ed.isActive('bulletList') : false,
      canLink: ed
        ? ed.state.selection instanceof TextSelection &&
          !ed.state.selection.empty &&
          ed.state.doc.textBetween(ed.state.selection.from, ed.state.selection.to).trim() !== '' &&
          imageIdsInDoc(ed.state.doc).size > 0
        : false,
    }),
  })

  const closeMenu = useCallback(() => {
    setMenu(null)
    if (editor && !editor.isDestroyed) editor.commands.focus(undefined, { scrollIntoView: false })
  }, [editor])

  const limitsText = `图片 ≤ ${formatBytes(ATTACHMENT_LIMITS.imageMaxBytes)} · 其他文件 ≤ ${formatBytes(ATTACHMENT_LIMITS.fileMaxBytes)} · 每次 ≤ ${ATTACHMENT_LIMITS.batchMax} 个 · 本次会话合计 ≤ ${formatBytes(ATTACHMENT_LIMITS.sessionMaxBytes)}`

  return (
    <div className="mt-8 flex flex-col">
      {/* 克制的小工具栏。长文中吸附在时间轴分隔线下方,按下时不抢走正文的选区与光标 */}
      <div
        role="toolbar"
        aria-label="正文工具"
        className="lt-editor-toolbar sticky z-10 flex flex-wrap items-center gap-0.5 border-b border-border/70 bg-background py-2"
        style={{ top: Math.max(0, Math.round(topInset)) }}
      >
        <ToolButton
          label="插入图片"
          title={`插入图片(JPG / PNG / WebP / GIF,单张 ≤ ${formatBytes(ATTACHMENT_LIMITS.imageMaxBytes)})`}
          onClick={() => openPicker(imageInputRef.current)}
        >
          <ImagePlus className="size-4" />
          <span className="text-xs">图片</span>
        </ToolButton>
        <ToolButton
          label="添加附件"
          title={`添加附件(单个 ≤ ${formatBytes(ATTACHMENT_LIMITS.fileMaxBytes)},每次最多 ${ATTACHMENT_LIMITS.batchMax} 个)`}
          onClick={() => openPicker(fileInputRef.current)}
        >
          <Paperclip className="size-4" />
          <span className="text-xs">附件</span>
        </ToolButton>
        <ToolButton label="插入日程" title="插入今天、明天、本篇日期或指定日期范围的日程" onClick={() => setSchedulePickerKey(docKey)}><CalendarDays className="size-4" /><span className="text-xs">日程</span></ToolButton>
        <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
        <ToolButton
          label="加粗"
          pressed={toolbar?.bold}
          onClick={() => editor?.chain().focus().toggleBold().run()}
        >
          <Bold className="size-4" />
        </ToolButton>
        <ToolButton
          label="列表"
          pressed={toolbar?.bulletList}
          onClick={() => editor?.chain().focus().toggleBulletList().run()}
        >
          <List className="size-4" />
        </ToolButton>
        <ToolButton
          label="关联图片"
          title="把选中的文字关联到本篇的一张图片(也可右键选中的文字)"
          disabled={!toolbar?.canLink}
          onClick={(e) => {
            if (!editor) return
            const rect = e.currentTarget.getBoundingClientRect()
            const { from, to } = editor.state.selection
            setMenu({ kind: 'text', x: rect.left, y: rect.bottom + 6, range: { from, to }, startInPicker: true })
          }}
        >
          <Link2 className="size-4" />
        </ToolButton>
        <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
        <ToolButton
          label="撤销"
          disabled={!toolbar?.canUndo}
          onClick={() => editor?.chain().focus().undo().run()}
        >
          <Undo2 className="size-4" />
        </ToolButton>
        <ToolButton
          label="重做"
          disabled={!toolbar?.canRedo}
          onClick={() => editor?.chain().focus().redo().run()}
        >
          <Redo2 className="size-4" />
        </ToolButton>

        <input
          ref={imageInputRef}
          type="file"
          accept={IMAGE_ACCEPT}
          multiple
          hidden
          onChange={onPicked}
        />
        <input ref={fileInputRef} type="file" multiple hidden onChange={onPicked} />
      </div>

      <p className="mt-2 text-xs leading-relaxed text-muted-foreground/80">
        {platformKind === 'desktop'
          ? persistenceStatus === 'error'
            ? '本地保存遇到问题，请在设置的“本地数据”中查看并重试。'
            : persistenceStatus === 'saving'
              ? '正在保存到本机……'
              : '文字、图片和附件会自动保存到本机。'
          : '当前为交互预览,文字、图片和附件仅保留在本次页面会话中,刷新后会重置。'}
        <span className="sr-only">{limitsText}</span>
      </p>

      <div role="status" aria-live="polite" className="min-h-0">
        {status && (
          <div
            className={cn(
              'mt-2 flex flex-col gap-0.5 text-xs leading-relaxed',
              status.tone === 'warn' ? 'text-destructive' : 'text-muted-foreground',
            )}
          >
            <p className="flex items-center gap-2">
              <span>{status.text}</span>
              {status.tone !== 'busy' && (
                <button
                  type="button"
                  onClick={() => showStatus(null)}
                  className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                >
                  知道了
                </button>
              )}
            </p>
            {status.details?.map((line) => (
              <p key={line} className="text-muted-foreground">
                {line}
              </p>
            ))}
          </div>
        )}
      </div>

      <div ref={setContentEl} className="relative mt-5">
        <EditorContent editor={editor} />
        <ImageLinkOverlay editor={editor} container={contentEl} />
      </div>

      {menu && editor && <EditorMenu editor={editor} request={menu} onClose={closeMenu} />}
      {schedulePickerKey && <SchedulePicker diaryDate={diaryDate} onClose={() => setSchedulePickerKey(null)} onManage={() => { setSchedulePickerKey(null); setScheduleManager(true) }} onInsert={card => {
        if (!editor || editor.isDestroyed || schedulePickerKey !== mountedKeyRef.current || schedulePickerKey !== latest.current.docKey) {
          showStatus({ tone: 'warn', text: '当前日记已切换，请在目标日记重新选择日程。' }, 6000)
        } else {
          editor.chain().focus().insertContentAt(editor.state.doc.content.size, [{ type: SCHEDULE_NODE, attrs: { card } }, { type: 'paragraph' }]).run()
        }
        setSchedulePickerKey(null)
      }} />}
      {scheduleManager && <ScheduleManager onClose={() => setScheduleManager(false)} />}
    </div>
  )
})

function ToolButton({
  label,
  title,
  pressed,
  disabled,
  onClick,
  children,
}: {
  label: string
  title?: string
  pressed?: boolean
  disabled?: boolean
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title ?? label}
      aria-pressed={pressed}
      disabled={disabled}
      // 按下时阻止默认行为:正文不失焦,选区保持原位
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        'flex h-8 min-w-8 items-center justify-center gap-1.5 rounded-md px-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-35',
        pressed ? 'bg-muted text-foreground' : '',
      )}
    >
      {children}
    </button>
  )
}
