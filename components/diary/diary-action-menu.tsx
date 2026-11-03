'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Plus, CalendarDays } from 'lucide-react'
import { ApiManagerIcon, DiaryExportIcon, DiaryImportIcon, HeaderButton, NewLifeNodeIcon } from '@/components/common/header-icons'
import { registerOverlay } from '@/lib/overlay-registry'

export type DiaryAction = 'new' | 'import' | 'export' | 'api' | 'schedule'

const actions = [
  { key: 'new', label: '新建人生节点', detail: '记下一个值得珍藏的时刻', Icon: NewLifeNodeIcon },
  { key: 'import', label: '导入日记', detail: '把另一份日记接到时间线上', Icon: DiaryImportIcon },
  { key: 'schedule', label: '导入日程', detail: '导入、编辑与管理课表或日程', Icon: CalendarDays },
  { key: 'export', label: '导出日记', detail: '带走全部日记，或一段时光', Icon: DiaryExportIcon },
  { key: 'api', label: '管理 API', detail: '为外部日记接入 AI 辅助整理', Icon: ApiManagerIcon },
] as const

export function DiaryActionMenu({ onSelect }: { onSelect: (action: DiaryAction) => void }) {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const id = useId()

  return (
    <>
      <HeaderButton
        ref={anchorRef}
        onClick={() => setOpen(true)}
        aria-label="添加与日记管理"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        title="添加与日记管理"
      >
        <Plus className="lt-anim-plus size-4" />
      </HeaderButton>
      {open && (
        <ActionMenu
          id={id}
          anchor={anchorRef.current}
          onClose={() => setOpen(false)}
          onSelect={(action) => {
            setOpen(false)
            onSelect(action)
          }}
        />
      )}
    </>
  )
}

function ActionMenu({ id, anchor, onClose, onSelect }: {
  id: string
  anchor: HTMLButtonElement | null
  onClose: () => void
  onSelect: (action: DiaryAction) => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const place = () => {
      const rect = anchor?.getBoundingClientRect()
      const left = Math.max(12, Math.min((rect?.right ?? window.innerWidth - 20) - 280, window.innerWidth - 292))
      dialog.style.left = `${left}px`
      dialog.style.top = `${Math.min((rect?.bottom ?? 60) + 10, Math.max(12, window.innerHeight - 382))}px`
    }
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    place()
    dialog.showModal()
    dialog.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true })
    const release = registerOverlay()
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('resize', place)
      dialog.close()
      document.body.style.overflow = previousOverflow
      release()
      anchor?.focus({ preventScroll: true })
    }
  }, [anchor])

  return createPortal(
    <dialog
      ref={dialogRef}
      aria-label="记录操作"
      className="lt-transfer-enter fixed m-0 w-[280px] max-w-[calc(100vw_-_24px)] overflow-visible rounded-xl border border-border bg-background p-2 text-foreground shadow-lg backdrop:bg-transparent"
      onCancel={(event) => { event.preventDefault(); onClose() }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return
        const rect = event.currentTarget.getBoundingClientRect()
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose()
      }}
      onKeyDown={(event) => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Tab'].includes(event.key)) return
        const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
        const index = items.indexOf(document.activeElement as HTMLButtonElement)
        event.preventDefault()
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
          : (index + (event.key === 'ArrowUp' || (event.key === 'Tab' && event.shiftKey) ? -1 : 1) + items.length) % items.length
        items[next]?.focus()
      }}
    >
      <div id={id} role="menu" aria-label="日记与人生节点">
        {actions.map(({ key, label, detail, Icon }) => (
          <button
            key={key}
            type="button"
            role="menuitem"
            aria-label={label}
            onClick={() => onSelect(key)}
            className="lt-hbtn flex w-full items-center gap-3.5 rounded-lg px-3 py-3 text-left text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
          >
            <Icon className="shrink-0" />
            <span>
              <span className="block text-sm text-foreground">{label}</span>
              <span className="mt-0.5 block text-[11px] text-muted-foreground">{detail}</span>
            </span>
          </button>
        ))}
      </div>
    </dialog>,
    document.body,
  )
}
