'use client'

import { useEffect, useRef, useState } from 'react'
import { Check, ChevronRight, Paperclip } from 'lucide-react'
import { AiDiaryIcon, DiaryImportIcon } from '@/components/common/header-icons'
import { useLifeStore } from '@/lib/life-store'
import { cn } from '@/lib/utils'
import { chooseDiaryImportPath, importDiaries, scanDiaries, type DiaryConflictAction, type DiaryScanResult } from '@/lib/diary-transfer'
import { inspectAiSources, commitAiImport, type AiSourceSummary } from '@/lib/ai-import'
import { storeDiaryImportReceipt, type DiaryImportReceipt } from './import-receipt'
import { buttonBase, quietButton, primaryButton, errorText } from './diary-page-frame'
import { AiImportUndo } from './ai-import-undo'

function scheduleConflictText(value: Record<string, unknown>): string {
  if (Array.isArray(value.entries)) return value.entries.map((item: Record<string, unknown>) => [item.date || `星期${item.weekday}`, item.time, item.title, item.location, Array.isArray(item.weeks) ? `周次 ${item.weeks.join(',')}` : '', item.notes].filter(Boolean).join(' · ')).join('\n')
  const grid = value.local as { columns?: Array<{ id: string; label: string }>; rows?: Array<{ cells: Record<string, string> }> } | undefined
  return grid?.rows?.map(row => grid.columns?.map(col => `${col.label}：${row.cells[col.id] || ''}`).join(' · ')).join('\n') || '空日程'
}

export function DiaryImportContent({ desktop, busy, receipt, onBusy, onClose, onExternal, onAiEntry, aiReview, initialScan, initialArchivePath }: {
  desktop: boolean
  busy: string | null
  receipt: DiaryImportReceipt | null
  onBusy: (value: string | null) => void
  onClose: () => void
  onExternal?: (source: AiSourceSummary) => void
  onAiEntry?: () => void
  aiReview?: { sessionId: string; scan: DiaryScanResult; onBack: () => void; onRecheck: () => Promise<void> }
  initialScan?: DiaryScanResult | null
  /** A ZIP received by the local phone link can be scanned without opening a second picker. */
  initialArchivePath?: string | null
}) {
  const { flushPersistence } = useLifeStore()
  const [scan, setScan] = useState<DiaryScanResult | null>(aiReview?.scan ?? initialScan ?? null)
  const [decisions, setDecisions] = useState<Record<string, DiaryConflictAction>>({})
  const [scheduleDecisions, setScheduleDecisions] = useState<Record<string, 'local' | 'incoming'>>({})
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [visibleDiaries, setVisibleDiaries] = useState(100)
  const [done, setDone] = useState(receipt)
  const runningRef = useRef(false)
  const autoScanStarted = useRef(false)
  const summaryRef = useRef<HTMLHeadingElement>(null)
  const unresolved = (scan?.conflicts.filter((conflict) => !decisions[conflict.date]).length ?? 0) + (scan?.scheduleConflicts?.filter(conflict => !scheduleDecisions[conflict.id]).length ?? 0)
  const count = (action: DiaryConflictAction) => scan?.conflicts.filter((conflict) => decisions[conflict.date] === action).length ?? 0

  useEffect(() => {
    if (scan || confirming) summaryRef.current?.focus({ preventScroll: false })
  }, [scan, confirming])

  const runScan = async (existingPath?: string) => {
    if (!desktop || runningRef.current) return
    if (aiReview) { await aiReview.onRecheck(); return }
    runningRef.current = true
    setError(null)
    setNotice(null)
    onBusy(existingPath ? '正在重新检查日记 ZIP…' : '正在选择日记 ZIP…')
    try {
      let path = existingPath ?? await chooseDiaryImportPath()
      if (!path) { setNotice('已取消选择文件。'); return }
      setScan(null)
      setDecisions({})
      setScheduleDecisions({})
      setConfirming(false)
      onBusy('正在保存当前编辑并检查日记 ZIP…')
      await flushPersistence()
      if (!existingPath && onExternal) {
        const inspected = await inspectAiSources([path])
        if (inspected.kind === 'external') { onExternal(inspected.source); return }
        path = inspected.archivePath
      }
      const next = await scanDiaries({ archivePath: path })
      setScan(next)
      setDecisions({})
      setConfirming(false)
      setVisibleDiaries(100)
    } catch (reason) {
      setError(errorText(reason, '无法读取这个日记包，请检查文件后重试。'))
    } finally {
      runningRef.current = false
      onBusy(null)
    }
  }

  useEffect(() => {
    if (!initialArchivePath || !desktop || scan || autoScanStarted.current) return
    autoScanStarted.current = true
    void runScan(initialArchivePath)
    // The received archive is a one-shot handoff from the desktop relay. If
    // scanning fails, the normal picker remains available for another attempt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desktop, initialArchivePath, scan])

  const runImport = async () => {
    if (!desktop || !scan || unresolved > 0 || runningRef.current) return
    runningRef.current = true
    setError(null)
    onBusy('正在保存当前编辑…')
    try {
      await flushPersistence()
      onBusy('正在备份本机资料并导入日记，请稍候…')
      const choices = scan.conflicts.map(({ date }) => ({ date, action: decisions[date] }))
      const result = aiReview
        ? await commitAiImport(aiReview.sessionId, scan.scanToken, choices)
        : await importDiaries({ archivePath: scan.archivePath, scanToken: scan.scanToken, decisions: choices, scheduleDecisions: (scan.scheduleConflicts ?? []).map(conflict => ({ id: conflict.id, side: scheduleDecisions[conflict.id] })) })
      storeDiaryImportReceipt(result, Boolean(aiReview))
      // Reload immediately: the old in-memory library must not write over the new native revision.
      window.location.reload()
    } catch (reason) {
      setError(errorText(reason, '这次导入没有完成，请重新检查日记包后重试。'))
      setConfirming(false)
      runningRef.current = false
      onBusy(null)
    }
  }

  if (done) return (
    <section aria-label="导入完成">
      <SuccessHeading title={done.aiRolledBack ? '本次 AI 导入已回退' : '日记已回到时间线上'} />
      <p role="status" className="mt-3 text-sm leading-7 text-muted-foreground">{done.aiRolledBack ? '日记已恢复到这次 AI 导入之前。回退前的资料也已保留安全备份。' : `新增 ${done.added} 篇，合并 ${done.merged} 篇，覆盖 ${done.replaced} 篇，跳过 ${done.skipped} 篇。`}</p>
      <div className="mt-7 rounded-lg border border-border p-5 text-sm leading-7 text-muted-foreground">
        {!done.aiRolledBack && <p>已收录 {done.attachmentCount} 个附件。现在可以回到时间轴查看原文与图片。</p>}
        {done.backupCreated && <p className="mt-2">导入前的本机资料已自动备份。可从设置打开数据目录，在 backups 文件夹中找到导入前备份。</p>}
      </div>
      {done.warnings?.map((warning, index) => <p key={index} role="alert" className="mt-4 text-sm leading-7 text-destructive">{warning}</p>)}
      {done.aiImport && <AiImportUndo disabled={Boolean(busy)} onBusy={onBusy} />}
      <div className="mt-8 flex flex-wrap gap-3">
        <button type="button" disabled={Boolean(busy)} className={primaryButton} onClick={onClose}>回到日记</button>
        <button type="button" disabled={Boolean(busy)} className={quietButton} onClick={() => setDone(null)}>继续导入</button>
      </div>
    </section>
  )

  if (!scan) return (
    <section aria-label="选择日记文件">
      <h2 className="font-serif text-2xl leading-relaxed md:text-3xl">把另一段时光接到这里</h2>
      <p className="mt-3 text-sm leading-7 text-muted-foreground">选择由 life-timeline 导出的日记 ZIP。先检查内容，再决定如何处理同一天的日记。</p>
      <div className="mt-8 rounded-xl border border-dashed border-border px-6 py-9 text-center">
        <DiaryImportIcon className="mx-auto size-9 text-muted-foreground" />
        <p className="mt-4 font-serif text-lg">日记、图片与随附文件，一起带回来</p>
        <p className="mt-2 text-xs leading-6 text-muted-foreground">保留段落、图片大小、环绕与旁侧位置，以及媒体和文件附件。</p>
        <button type="button" disabled={!desktop || Boolean(busy)} onClick={() => void runScan()} className={cn(primaryButton, 'lt-hbtn mt-6 inline-flex items-center gap-2')}><DiaryImportIcon className="size-4" />选择日记 ZIP</button>
      </div>
      {onAiEntry && <button type="button" disabled={Boolean(busy)} onClick={onAiEntry} className="lt-hbtn mt-4 flex w-full items-start gap-4 rounded-xl border border-border px-5 py-5 text-left transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-40"><AiDiaryIcon className="mt-0.5 size-6 shrink-0 text-muted-foreground" /><span><span className="block font-serif text-lg">其他格式／照片 · AI 辅助导入</span><span className="mt-1.5 block text-xs leading-6 text-muted-foreground">文本、网页、外部 ZIP 或一组照片。先在本机查看来源，再决定是否交给你配置的 AI 整理。</span></span><ChevronRight className="mt-1 ml-auto size-4 shrink-0 text-muted-foreground" /></button>}
      <div className="mt-7 grid gap-5 text-sm leading-relaxed text-muted-foreground sm:grid-cols-3">
        <p><span className="mb-1 block font-mono text-xs text-muted-foreground/70">01 / 检查</span>查看日记日期、标题和附件数量。</p>
        <p><span className="mb-1 block font-mono text-xs text-muted-foreground/70">02 / 选择</span>遇到同一天，逐篇选择合并、覆盖或跳过。</p>
        <p><span className="mb-1 block font-mono text-xs text-muted-foreground/70">03 / 收录</span>确认后先备份本机资料，再完成导入。</p>
      </div>
      <p className="mt-7 text-xs leading-6 text-muted-foreground">选择文件和预览都不会修改已有日记。请选择日记导出生成的 ZIP；整库备份请在设置中使用「从备份恢复」。</p>
      <AiImportUndo disabled={Boolean(busy)} onBusy={onBusy} />
      {error && <p role="alert" className="mt-5 text-sm leading-relaxed text-destructive">{error}</p>}
      {notice && <p role="status" className="mt-5 text-sm text-muted-foreground">{notice}</p>}
      <button type="button" disabled={Boolean(busy)} className={cn(quietButton, 'mt-8')} onClick={onClose}>取消</button>
    </section>
  )

  if (confirming) return (
    <section aria-label="确认日记导入">
      <h2 ref={summaryRef} tabIndex={-1} className="font-serif text-2xl leading-relaxed outline-none md:text-3xl">确认这次收录</h2>
      <p className="mt-3 text-sm leading-7 text-muted-foreground">只处理下面这些日记。开始前，会自动备份本机当前的完整资料。</p>
      <dl className="mt-7 grid grid-cols-2 gap-4 rounded-lg border border-border p-5 text-sm sm:grid-cols-4">
        {([['新增', scan.newCount], ['合并', count('merge')], ['覆盖', count('replace')], ['跳过', count('skip')]] as const).map(([label, value]) => (
          <div key={label}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-2 font-serif text-2xl">{value}<span className="ml-1.5 text-xs text-muted-foreground">篇</span></dd></div>
        ))}
      </dl>
      {count('merge') > 0 && <p className="mt-5 text-sm leading-7 text-muted-foreground">合并时，本机正文在前、导入正文在后；原有段落和附件排版保留。本机日记标题与重要程度保持原样。</p>}
      {count('replace') > 0 && (
        <div className="mt-5 rounded-lg border border-destructive/30 bg-destructive/5 px-5 py-4">
          <p className="text-sm leading-7">将覆盖本机 {count('replace')} 篇同日期日记，以导入版本的标题、正文和附件为准。</p>
          <p className="mt-2 break-words font-mono text-xs leading-6 text-muted-foreground">{scan.conflicts.filter((conflict) => decisions[conflict.date] === 'replace').map((conflict) => conflict.date).join(' · ')}</p>
        </div>
      )}
      <p className="mt-5 text-xs leading-6 text-muted-foreground">确认后请等待完成。完成时页面会自动重新载入，读取刚导入的日记。</p>
      {aiReview && <p className="mt-3 text-xs leading-6 text-muted-foreground">如果结果不满意，可在完成页或再次进入导入页面时回退本次 AI 导入。已有后续编辑时会阻止直接回退，保护新内容。</p>}
      {error && <p role="alert" className="mt-5 text-sm leading-relaxed text-destructive">{error}</p>}
      <div className="mt-8 flex flex-wrap gap-3">
        <button type="button" disabled={!desktop || Boolean(busy) || !scan.canImport} className={primaryButton} onClick={() => void runImport()}>{count('replace') > 0 ? `确认导入并覆盖 ${count('replace')} 篇` : '确认导入'}</button>
        <button type="button" disabled={Boolean(busy)} className={quietButton} onClick={() => setConfirming(false)}>返回检查</button>
        <button type="button" disabled={Boolean(busy)} className={cn(buttonBase, 'text-muted-foreground hover:bg-muted')} onClick={onClose}>取消</button>
      </div>
    </section>
  )

  return (
    <section aria-label="检查导入内容">
      <h2 ref={summaryRef} tabIndex={-1} className="font-serif text-2xl leading-relaxed outline-none md:text-3xl">这份日记，准备怎样收录？</h2>
      <p className="mt-3 break-all text-sm text-muted-foreground">{aiReview ? 'AI 整理后的日记 · 尚未写入本机日记库' : fileName(scan.archivePath)}</p>
      <div className="mt-7 border-y border-border py-5">
        <p className="font-serif text-lg">{scan.diaryCount} 篇日记 <span className="mx-2 text-border">/</span> <span className="text-base text-muted-foreground">{scan.attachmentCount} 个附件</span></p>
        <p className="mt-2 font-mono text-xs leading-6 text-muted-foreground">{scan.startDate ?? '—'} — {scan.endDate ?? '—'}</p>
        <p className="mt-2 text-xs text-muted-foreground">{scan.newCount} 篇可直接新增，{scan.conflicts.length} 篇与本机日期相同。</p>
      </div>
      {scan.warnings.length > 0 && <div role="note" className="mt-5 rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm leading-7 text-muted-foreground">{scan.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div>}
      {!!scan.scheduleConflicts?.length && <section className="mt-6 space-y-4" aria-label="日程版本冲突"><h3 className="font-serif text-lg">选择日程版本</h3><p className="text-sm leading-7 text-muted-foreground">两台设备上的日程不一致。请选择使用哪个版本；总日程的选择会影响已有的关联日记。单张表格的修改单独选择。导入后可在「导入日程」页面回退一次。</p>{scan.scheduleConflicts.map(conflict => <fieldset key={conflict.id} className="rounded-lg border border-border p-4"><legend className="px-2 text-sm">{conflict.name} · {conflict.kind === 'source' ? '总日程' : '单张日程'}</legend>{(['local', 'incoming'] as const).map(side => <label key={side} className="my-3 block text-sm"><input type="radio" name={conflict.id} checked={scheduleDecisions[conflict.id] === side} onChange={() => setScheduleDecisions(current => ({ ...current, [conflict.id]: side }))} /> {side === 'local' ? '保留本机版本' : '采用传入版本'}{typeof conflict[side].device === 'string' && `（${conflict[side].device}）`}{typeof conflict[side].updatedAt === 'string' && <span className="ml-2 text-xs text-muted-foreground">{new Date(conflict[side].updatedAt as string).toLocaleString()}</span>}</label>)}<details><summary className="cursor-pointer text-xs text-muted-foreground">查看两份日程内容</summary><div className="lt-schedule-fields mt-3">{(['local', 'incoming'] as const).map(side => <div key={side}><p className="mb-2 text-sm">{side === 'local' ? '本机' : '传入'}</p><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border border-border p-3 text-xs">{scheduleConflictText(conflict[side])}</pre></div>)}</div></details></fieldset>)}</section>}
      <details className="mt-6 rounded-lg border border-border" open={scan.diaries.length <= 8}>
        <summary className="cursor-pointer rounded-lg px-4 py-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">查看日记清单（{scan.diaries.length} 篇）</summary>
        <ul aria-label="待导入日记清单" className="max-h-72 overflow-y-auto border-t border-border px-4">
          {scan.diaries.slice(0, visibleDiaries).map((diary) => <li key={diary.id} className="flex items-start justify-between gap-3 border-b border-border/50 py-3 last:border-b-0"><div className="min-w-0"><span className="block font-mono text-xs text-muted-foreground">{diary.date}</span><span className="mt-1 block break-words text-sm">{diary.title}</span></div><span className="inline-flex shrink-0 items-center gap-1 pt-1 text-xs text-muted-foreground"><Paperclip className="size-3" />{diary.attachmentCount}</span></li>)}
          {scan.diaries.length > visibleDiaries && <li className="py-3"><button type="button" onClick={() => setVisibleDiaries((value) => value + 100)} className="text-xs text-muted-foreground underline underline-offset-4">再显示 100 篇</button></li>}
        </ul>
      </details>
      {scan.conflicts.length > 0 && (
        <section aria-label="处理同日期日记" className="mt-8">
          <h3 className="font-serif text-xl">同一天，有两份记录</h3>
          <p className="mt-3 text-sm leading-7 text-muted-foreground">合并：本机正文在前，导入正文在后，保留各自排版与附件。覆盖：只将这一天换成导入版本。跳过：保留本机版本。</p>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="mr-1 text-xs text-muted-foreground">统一选择</span>
            {([{ action: 'merge', label: '全部合并' }, { action: 'replace', label: '全部覆盖' }, { action: 'skip', label: '全部跳过' }] as const).map(({ action, label }) => <button key={action} type="button" disabled={Boolean(busy)} onClick={() => setDecisions(Object.fromEntries(scan.conflicts.map((conflict) => [conflict.date, action])))} className="rounded border border-border px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-40">{label}</button>)}
          </div>
          <div className="mt-4 space-y-4">
            {scan.conflicts.map((conflict) => <ConflictCard key={conflict.date} conflict={conflict} action={decisions[conflict.date]} disabled={Boolean(busy)} onChange={(action) => setDecisions((current) => ({ ...current, [conflict.date]: action }))} />)}
          </div>
          <p aria-live="polite" className="mt-4 text-sm text-muted-foreground">{unresolved > 0 ? `还有 ${unresolved} 篇需要选择处理方式。` : '每一天的处理方式都已选好。'}</p>
        </section>
      )}
      {error && <p role="alert" className="mt-5 text-sm leading-relaxed text-destructive">{error}</p>}
      {notice && <p role="status" className="mt-5 text-sm text-muted-foreground">{notice}</p>}
      <div className="mt-8 flex flex-wrap gap-3">
        <button type="button" disabled={!desktop || Boolean(busy) || unresolved > 0 || !scan.canImport} onClick={() => { setError(null); setConfirming(true) }} className={cn(primaryButton, 'inline-flex items-center gap-1.5')}>下一步：确认导入<ChevronRight className="size-4" /></button>
        <button type="button" disabled={Boolean(busy)} onClick={() => void runScan(scan.archivePath)} className={quietButton}>重新检查</button>
        {aiReview
          ? <button type="button" disabled={Boolean(busy)} onClick={aiReview.onBack} className={quietButton}>返回整理预览</button>
          : <button type="button" disabled={Boolean(busy)} onClick={() => void runScan()} className={quietButton}>更换文件</button>}
        <button type="button" disabled={Boolean(busy)} onClick={onClose} className={cn(buttonBase, 'text-muted-foreground hover:bg-muted')}>取消</button>
      </div>
    </section>
  )
}

function ConflictCard({ conflict, action, disabled, onChange }: {
  conflict: DiaryScanResult['conflicts'][number]
  action?: DiaryConflictAction
  disabled: boolean
  onChange: (action: DiaryConflictAction) => void
}) {
  return (
    <fieldset disabled={disabled} className="rounded-lg border border-border p-4 sm:p-5">
      <legend className="px-1 font-mono text-sm">{conflict.date}</legend>
      <div className="grid gap-4 sm:grid-cols-2">
        {([{ label: '本机', value: conflict.local }, { label: '导入', value: conflict.incoming }] as const).map(({ label, value }) => (
          <div key={label}><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1.5 break-words text-sm">{value.title}</p><p className="mt-2 text-xs text-muted-foreground">{value.characterCount} 字 · {value.attachmentCount} 个附件</p></div>
        ))}
      </div>
      {conflict.identical && <p className="mt-3 text-xs text-muted-foreground">两份内容相同，可以选择跳过，避免重复收录。</p>}
      <div className="mt-4 flex flex-wrap gap-2">
        {([{ value: 'merge', label: '合并' }, { value: 'replace', label: '覆盖' }, { value: 'skip', label: '跳过' }] as const).map((choice) => (
          <label key={choice.value} className={cn('inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-xs transition-colors hover:bg-muted', action === choice.value ? 'border-primary/50 bg-primary/5 text-foreground' : 'border-border text-muted-foreground')}>
            <input type="radio" name={`diary-conflict-${conflict.date}`} aria-label={`${conflict.date} ${choice.label}`} value={choice.value} checked={action === choice.value} onChange={() => onChange(choice.value)} className="size-3 accent-primary" />{choice.label}
          </label>
        ))}
      </div>
    </fieldset>
  )
}

function SuccessHeading({ title }: { title: string }) {
  return <div className="flex items-center gap-3"><span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-primary/25 text-primary"><Check className="size-4" /></span><h2 className="font-serif text-2xl leading-relaxed md:text-3xl">{title}</h2></div>
}

function fileName(path: string): string { return path.split(/[\\/]/).pop() || path }
