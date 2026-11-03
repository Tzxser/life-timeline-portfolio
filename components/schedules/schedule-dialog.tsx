'use client'
import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { registerOverlay } from '@/lib/overlay-registry'

export function ScheduleDialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  const close = () => {
    // Android Back dispatches cancel without moving focus first. Settle the
    // active field's blur save before the editing view is unmounted.
    const focused = document.activeElement
    if (focused instanceof HTMLElement && ref.current?.contains(focused)) focused.blur()
    onClose()
  }
  useEffect(() => {
    const dialog = ref.current!
    const focus = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialog.showModal()
    const release = registerOverlay()
    return () => { dialog.close(); release(); document.body.style.overflow = overflow; focus?.focus({ preventScroll: true }) }
  }, [])
  return createPortal(<dialog ref={ref} aria-label={title} className="lt-schedule-dialog" onCancel={e => { e.preventDefault(); close() }}>
    <header><h2>{title}</h2><button type="button" aria-label="关闭日程窗口" onClick={close}><X size={20} /></button></header>
    <div className="lt-schedule-dialog-body">{children}</div>
  </dialog>, document.body)
}
