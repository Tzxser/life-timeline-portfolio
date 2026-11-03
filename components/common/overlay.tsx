'use client'

// 轻量遮罩层:供 Drawer / Modal / 搜索共用
// Escape 关闭 + 点击遮罩关闭 + 打开时锁定页面滚动

import { useEffect, type ReactNode } from 'react'
import { registerOverlay } from '@/lib/overlay-registry'

interface OverlayProps {
  open: boolean
  onClose: () => void
  children: ReactNode
  /** 内容对齐方式 */
  align?: 'left' | 'right' | 'center-top'
  label: string
}

export function Overlay({ open, onClose, children, align = 'center-top', label }: OverlayProps) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    const release = registerOverlay()
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
      release()
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="lt-overlay fixed inset-0 z-50" data-overlay-align={align} role="dialog" aria-modal="true" aria-label={label}>
      <button
        type="button"
        aria-label="关闭"
        onClick={onClose}
        className="animate-overlay-in absolute inset-0 cursor-default bg-foreground/20"
      />
      <div
        className={
          align === 'left'
            ? 'animate-drawer-left absolute inset-y-0 left-0'
            : align === 'right'
              ? 'animate-drawer-right absolute inset-y-0 right-0'
              : 'animate-modal-in absolute inset-x-0 top-[14vh] mx-auto w-full max-w-xl px-4'
        }
      >
        {children}
      </div>
    </div>
  )
}
