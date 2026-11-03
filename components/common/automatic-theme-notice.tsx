'use client'

import { useEffect, useRef } from 'react'
import { Leaf } from 'lucide-react'
import { useTheme, THEME_LABEL } from '@/lib/theme'
import { useAnyOverlayOpen } from '@/lib/overlay-registry'

/** A top-of-page, non-modal suggestion. Never steals the editor's focus. */
export function AutomaticThemeNotice() {
  const { prompt, respondToPrompt, disabledNotice, dismissDisabledNotice, automation } = useTheme()
  const overlayOpen = useAnyOverlayOpen()
  const noticeRef = useRef<HTMLElement>(null)
  const visible = !overlayOpen && (prompt !== null || disabledNotice)
  useEffect(() => {
    if (!visible) return
    const close = () => disabledNotice ? dismissDisabledNotice() : respondToPrompt('cancel')
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close() }
    }
    const node = noticeRef.current
    node?.addEventListener('cancel', close)
    document.addEventListener('keydown', escape)
    return () => { node?.removeEventListener('cancel', close); document.removeEventListener('keydown', escape) }
  }, [visible, disabledNotice, dismissDisabledNotice, respondToPrompt])
  if (!visible) return null
  return (
    <section ref={noticeRef} role="dialog" aria-modal="false" aria-label={disabledNotice ? '自动调色已关闭' : '自动调色提醒'} data-theme-notice
      className="animate-modal-in fixed inset-x-4 top-[max(16px,env(safe-area-inset-top))] z-[85] mx-auto max-w-md rounded-xl border border-border bg-background p-4 text-foreground shadow-lg">
      <div className="flex items-start gap-3">
        <Leaf className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium" role="status">{disabledNotice ? '已关闭自动调色' : prompt?.kind === 'eyecare' ? `已使用 ${automation.eyeCareAfterMinutes} 分钟，切换护眼色调吗？` : `到设定时间了，切换${THEME_LABEL[prompt!.theme]}吗？`}</p>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{disabledNotice ? '你可以通过「设置 → 自动调色」随时重新开启。' : prompt?.reminder}</p>
          {!disabledNotice && prompt?.kind === 'eyecare' && <p className="mt-1 text-xs text-muted-foreground">退出软件后恢复原配色；切到后台不会结束护眼。</p>}
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        {disabledNotice ? <button className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground" onClick={dismissDisabledNotice}>知道了</button> : <>
          <button className="mr-auto rounded-md px-2 py-2 text-xs text-muted-foreground hover:bg-muted" onClick={() => respondToPrompt('disable')}>不再自动调色</button>
          <button className="rounded-md border border-border px-4 py-2 text-sm hover:bg-muted" onClick={() => respondToPrompt('cancel')}>取消</button>
          <button className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground" onClick={() => respondToPrompt('accept')}>确定</button>
        </>}
      </div>
    </section>
  )
}
