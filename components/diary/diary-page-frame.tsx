'use client'

import { useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, CalendarDays } from 'lucide-react'
import { ApiManagerIcon, AiDiaryIcon, DiaryExportIcon, DiaryImportIcon, PhoneComputerIcon } from '@/components/common/header-icons'
import { registerOverlay } from '@/lib/overlay-registry'

export const buttonBase = 'rounded-md px-4 py-2.5 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40'
export const quietButton = `${buttonBase} border border-border text-muted-foreground hover:bg-muted hover:text-foreground`
export const primaryButton = `${buttonBase} bg-primary text-primary-foreground hover:opacity-90`
export const fieldClass = 'w-full rounded-md border border-input bg-background px-3 py-2.5 text-sm text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-40'

const pageDetails = {
  schedule: { title: '导入日程', subtitle: '安排每一天，也为变化留余地', Icon: CalendarDays },
  export: { title: '导出日记', subtitle: '把日记与随附的记忆一起保存', Icon: DiaryExportIcon },
  import: { title: '导入日记', subtitle: '让另一段时光回到这里', Icon: DiaryImportIcon },
  ai: { title: 'AI 辅助导入', subtitle: '整理旧日记，把决定留给自己', Icon: AiDiaryIcon },
  api: { title: '管理 API', subtitle: '连接你选择的 AI 服务', Icon: ApiManagerIcon },
  phone: { title: '连接手机', subtitle: '在本机网络中临时传送日记', Icon: PhoneComputerIcon },
} as const

export function DiaryPageFrame({ mode, busy, onClose, children, backLabel = '返回人生时间轴' }: {
  mode: keyof typeof pageDetails
  busy: string | null
  onClose: () => void
  children: ReactNode
  backLabel?: string
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const backRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const { title, subtitle, Icon } = pageDetails[mode]

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const previousFocus = document.activeElement as HTMLElement | null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialog.showModal()
    backRef.current?.focus({ preventScroll: true })
    const release = registerOverlay()
    return () => {
      dialog.close()
      document.body.style.overflow = previousOverflow
      release()
      previousFocus?.focus?.({ preventScroll: true })
    }
  }, [])

  return createPortal(
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-modal="true"
      aria-busy={Boolean(busy)}
      className="lt-diary-page lt-transfer-enter fixed inset-0 m-0 h-dvh max-h-none w-screen max-w-none overflow-y-auto border-0 bg-background p-0 text-foreground"
      onCancel={(event) => { event.preventDefault(); if (!busy) onClose() }}
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return
        const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, a[href], [tabindex="0"]'))
          .filter((element) => !element.closest('details:not([open])') && !element.matches('.sr-only, [aria-hidden="true"]') && element.getClientRects().length > 0)
        if (!focusable.length) { event.preventDefault(); return }
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) {
          event.preventDefault(); last.focus()
        } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === event.currentTarget)) {
          event.preventDefault(); first.focus()
        }
      }}
    >
      <header className="sticky top-0 z-10 flex items-center justify-between gap-4 border-b border-border bg-background/95 px-5 py-4 backdrop-blur-sm md:px-10">
        <div className="flex items-center gap-3">
          <button ref={backRef} type="button" aria-label={backLabel} title="返回（Esc）" disabled={Boolean(busy)} onClick={onClose} className="flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-wait disabled:opacity-40"><ArrowLeft className="size-4" /></button>
          <div><h1 id={titleId} className="font-serif text-lg tracking-wide">{title}</h1><p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p></div>
        </div>
        <span aria-hidden="true" className="font-mono text-xs tracking-[0.28em] text-muted-foreground/70">LIFE</span>
      </header>
      <main className="mx-auto w-full max-w-3xl px-6 pt-10 pb-16 md:pt-14">
        <div aria-hidden="true" className="mb-6 flex size-12 items-center justify-center rounded-full border border-border text-muted-foreground"><Icon className="size-6" /></div>
        {children}
        {busy && <p role="status" aria-live="polite" className="mt-5 text-sm text-muted-foreground">{busy}</p>}
      </main>
    </dialog>, document.body,
  )
}

export function errorText(reason: unknown, fallback: string): string {
  if (reason instanceof Error) return reason.message || fallback
  return typeof reason === 'string' && reason.trim() ? reason : fallback
}
