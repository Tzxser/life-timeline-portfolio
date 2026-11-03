'use client'

// 正文中的附件卡片:像文章里夹着的一份资料,而不是上传管理后台。
// 下载与移除沿用原行为；安卓可另用手机上安装的应用查看原文件。

import { useEffect, useState } from 'react'
import { Node, NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react'
import {
  Download,
  ExternalLink,
  File,
  FileArchive,
  FileAudio,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Presentation,
  X,
  type LucideIcon,
} from 'lucide-react'
import {
  downloadAttachment,
  fileExtension,
  formatBytes,
  useAttachment,
} from '@/lib/session-attachments'
import { ATTACHMENT_NODE } from '@/lib/rich-content'
import { cn } from '@/lib/utils'
import { isAndroidRuntime } from '@/lib/platform/runtime'
import { invokeDesktop } from '@/lib/desktop-commands'

export const LifeAttachment = Node.create({
  name: ATTACHMENT_NODE,
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    const attr = (name: string, numeric = false) => ({
      default: null,
      parseHTML: (el: HTMLElement) => {
        const raw = el.getAttribute(`data-${name}`)
        if (raw === null) return null
        return numeric ? Number(raw) || 0 : raw
      },
      renderHTML: (attrs: Record<string, unknown>) => {
        const key = name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
        const value = attrs[key]
        return value === null || value === undefined ? {} : { [`data-${name}`]: String(value) }
      },
    })
    return {
      attachmentId: attr('attachment-id'),
      name: attr('name'),
      mimeType: attr('mime-type'),
      byteSize: attr('byte-size', true),
      note: attr('note'),
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-life-attachment]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', { 'data-life-attachment': '', ...HTMLAttributes }]
  },

  renderText() {
    return ''
  },

  addNodeView() {
    return ReactNodeViewRenderer(AttachmentView)
  },
})

function iconFor(name: string, mimeType: string): { Icon: LucideIcon; label: string } {
  const ext = fileExtension(name)
  if (ext === 'pdf') return { Icon: FileText, label: 'PDF' }
  if (['doc', 'docx', 'odt', 'rtf', 'pages'].includes(ext)) return { Icon: FileText, label: '文档' }
  if (['xls', 'xlsx', 'csv', 'ods', 'numbers'].includes(ext)) return { Icon: FileSpreadsheet, label: '表格' }
  if (['ppt', 'pptx', 'odp', 'key'].includes(ext)) return { Icon: Presentation, label: '演示文稿' }
  if (['zip', 'rar', '7z', 'tar', 'gz', 'tgz'].includes(ext)) return { Icon: FileArchive, label: '压缩包' }
  if (['txt', 'md', 'markdown'].includes(ext)) return { Icon: FileText, label: '文本' }
  if (mimeType.startsWith('audio/')) return { Icon: FileAudio, label: '音频' }
  if (mimeType.startsWith('video/')) return { Icon: FileVideo, label: '视频' }
  if (mimeType.startsWith('image/')) return { Icon: FileImage, label: '图片' }
  return { Icon: File, label: ext ? ext.toUpperCase() : '文件' }
}

function AttachmentView({ node, selected, deleteNode, editor }: ReactNodeViewProps) {
  const [android, setAndroid] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [opening, setOpening] = useState(false)
  useEffect(() => setAndroid(isAndroidRuntime()), [])
  const attrs = node.attrs as {
    attachmentId: string | null
    name: string | null
    mimeType: string | null
    byteSize: number | null
    note: string | null
  }
  const name = attrs.name || '未命名文件'
  const entry = useAttachment(attrs.attachmentId)
  const { Icon, label } = iconFor(name, attrs.mimeType ?? '')
  const editable = editor.isEditable
  const openFile = async () => {
    if (!attrs.attachmentId || !android || opening) return
    setOpening(true)
    setError(null)
    try {
      await invokeDesktop('attachment_open', { request: { id: attrs.attachmentId } })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法打开附件。可以先保存文件，再选择手机上的查看应用。')
    } finally {
      setOpening(false)
    }
  }

  return (
    <NodeViewWrapper className="my-4" data-drag-handle="">
      <div
        data-gallery-id={attrs.attachmentId ?? undefined}
        className={cn(
          'lt-attachment-card flex items-center gap-3 rounded-md border bg-card px-3 py-2.5 text-card-foreground transition-colors',
          selected && editable ? 'border-ring/70' : 'border-border',
        )}
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
          <Icon className="size-4" aria-hidden="true" />
        </span>

        <span className="flex min-w-0 flex-1 flex-col">
          {/* 文件名按纯文本渲染;过长省略显示,悬停可见完整名称 */}
          <span className="truncate text-sm leading-relaxed text-foreground" title={name}>
            {name}
          </span>
          <span className="truncate text-xs leading-relaxed text-muted-foreground">
            {label}
            {attrs.byteSize ? ` · ${formatBytes(attrs.byteSize)}` : ''}
            {entry?.status === 'ready'
              ? attrs.note
                ? ` · ${attrs.note}`
                : ''
              : entry?.status === 'loading'
                ? ' · 正在加载'
                : entry?.status === 'error'
                  ? ` · ${entry.error || '文件无法读取'}`
                  : ' · 文件已不在本次资料库中'}
          </span>
        </span>

        {android && <button
          type="button"
          onClick={() => void openFile()}
          disabled={!entry || entry.status !== 'ready' || opening}
          aria-label={`打开 ${name}`}
          title="用手机应用打开"
          className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        ><ExternalLink className="size-4" /></button>}
        <button
          type="button"
          onClick={() => {
            setError(null)
            void downloadAttachment(attrs.attachmentId).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : '保存附件失败，请重试。'))
          }}
          disabled={!entry || entry.status !== 'ready'}
          aria-label={`下载 ${name}`}
          title="下载原文件"
          className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        >
          <Download className="size-4" />
        </button>
        {editable && (
          <button
            type="button"
            onClick={() => deleteNode()}
            aria-label={`从正文移除 ${name}`}
            title="从正文移除(不会删除电脑上的原文件,可撤销)"
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
          >
            <X className="size-4" />
          </button>
        )}
      </div>
      {error && <p role="alert" className="mt-2 text-xs leading-relaxed text-destructive">{error}</p>}
    </NodeViewWrapper>
  )
}
