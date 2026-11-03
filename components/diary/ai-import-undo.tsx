'use client'

import { useEffect, useRef, useState } from 'react'
import { Undo2 } from 'lucide-react'
import { getAiImportStatus, rollbackAiImport, type AiUndoInfo } from '@/lib/ai-import'
import { useLifeStore } from '@/lib/life-store'
import { cn } from '@/lib/utils'
import { quietButton, primaryButton, errorText } from './diary-page-frame'
import { storeAiRollbackReceipt } from './import-receipt'

export function AiImportUndo({ disabled, onBusy }: { disabled: boolean; onBusy: (value: string | null) => void }) {
  const { platformKind, flushPersistence } = useLifeStore()
  const [undo, setUndo] = useState<AiUndoInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const running = useRef(false)

  useEffect(() => {
    if (platformKind !== 'desktop') return
    let alive = true
    void getAiImportStatus().then((result) => { if (alive) setUndo(result.latestUndo) })
      .catch((reason) => { if (alive) setError(errorText(reason, '暂时无法读取最近一次 AI 导入的回退状态。')) })
    return () => { alive = false }
  }, [platformKind])

  const rollback = async () => {
    if (!undo?.canRollback || running.current || disabled) return
    running.current = true
    setError(null)
    onBusy('正在保存并检查当前资料…')
    try {
      await flushPersistence()
      onBusy('正在回退本次 AI 导入，请稍候…')
      const result = await rollbackAiImport(undo.id)
      if (!result.restored) throw new Error('资料未回退，请检查当前状态后重试。')
      storeAiRollbackReceipt()
      window.location.reload()
    } catch (reason) {
      setError(errorText(reason, '回退未完成，现有资料仍然保留。'))
      setConfirming(false)
      try { setUndo((await getAiImportStatus()).latestUndo) } catch { /* Keep the original failure visible. */ }
      running.current = false
      onBusy(null)
    }
  }

  if (!undo && !error) return null
  return (
    <aside aria-label="AI 导入回退" className="mt-8 rounded-lg border border-border bg-muted/20 p-5">
      {undo && <>
        <h3 className="flex items-center gap-2 font-serif text-lg"><Undo2 className="size-4 text-muted-foreground" />最近一次 AI 导入</h3>
        <p className="mt-2 text-xs leading-6 text-muted-foreground">{new Date(undo.createdAt).toLocaleString('zh-CN')} · 新增 {undo.added} 篇，合并 {undo.merged} 篇，覆盖 {undo.replaced} 篇。</p>
        <p className="mt-3 text-sm leading-7 text-muted-foreground">{undo.canRollback ? '如果整理结果不满意，可以恢复到这次 AI 导入之前。为保护之后的编辑，已有新修改时不会直接回退。' : (undo.reason ?? '导入后已有其他修改，不能直接回退。')}</p>
        {!undo.canRollback && <p className="mt-2 text-xs leading-6 text-muted-foreground">导入前备份仍在本机数据目录的 backups 文件夹。可在设置中打开数据目录；需要整库恢复时，请先备份当前资料。</p>}
        {!confirming
          ? <button type="button" disabled={disabled || !undo.canRollback} onClick={() => setConfirming(true)} className={cn(quietButton, 'mt-4 inline-flex items-center gap-2')}><Undo2 className="size-3.5" />回退本次 AI 导入</button>
          : <div role="alertdialog" aria-label="确认回退 AI 导入" className="mt-4 border-t border-border pt-4"><p className="text-sm leading-7">确定恢复到本次 AI 导入之前吗？这次新增的日记会移除，合并和覆盖的日记恢复原样。当前资料会先另存一份安全备份。</p><div className="mt-4 flex flex-wrap gap-3"><button type="button" disabled={disabled} onClick={() => setConfirming(false)} className={quietButton}>保留导入结果</button><button type="button" disabled={disabled} onClick={() => void rollback()} className={primaryButton}>确认回退</button></div></div>}
      </>}
      {error && <p role="alert" className="mt-3 text-sm leading-7 text-destructive">{error}</p>}
    </aside>
  )
}
