'use client'

import { useMemo, useRef, useState } from 'react'
import { Check } from 'lucide-react'
import { DiaryExportIcon } from '@/components/common/header-icons'
import { useLifeStore } from '@/lib/life-store'
import { collectAttachmentIds, docForEvent } from '@/lib/rich-content'
import { cn } from '@/lib/utils'
import { isDailyEntry, todayKey } from '@/types/life-event'
import {
  chooseDiaryExportPath,
  exportDiaries,
  isDiaryDate,
  scanDiaries,
  type DiaryScanResult,
  type DiaryExportResult,
} from '@/lib/diary-transfer'
import type { DiaryImportReceipt } from './import-receipt'
import { DiaryPageFrame } from './diary-page-frame'
import { DiaryImportContent } from './diary-import-content'
import { AiImportPage } from './ai-import-page'
import type { AiSourceSummary } from '@/lib/ai-import'

export type DiaryTransferMode = 'import' | 'export'

const buttonBase = 'rounded-md px-4 py-2.5 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40'
const quietButton = `${buttonBase} border border-border text-muted-foreground hover:bg-muted hover:text-foreground`
const primaryButton = `${buttonBase} bg-primary text-primary-foreground hover:opacity-90`
const fieldClass = 'w-full rounded-md border border-input bg-background px-3 py-2.5 font-mono text-sm text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-40'

export function DiaryTransferPage({ mode, receipt, initialArchivePath, onClose }: {
  mode: DiaryTransferMode
  receipt?: DiaryImportReceipt | null
  initialArchivePath?: string | null
  onClose: () => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const { platformKind, flushPersistence } = useLifeStore()
  const desktop = platformKind === 'desktop'
  const [aiOpen, setAiOpen] = useState(false)
  const [source, setSource] = useState<AiSourceSummary | null>(null)
  const [nativeScan, setNativeScan] = useState<DiaryScanResult | null>(null)
  const [importReceipt, setImportReceipt] = useState(receipt ?? null)

  if (mode === 'import' && aiOpen) return (
    <AiImportPage
      initialSource={source}
      onClose={() => { setAiOpen(false); setSource(null); setImportReceipt(null) }}
      onNativeArchive={async (archivePath) => {
        await flushPersistence()
        const inspected = await scanDiaries({ archivePath })
        setNativeScan(inspected)
        setSource(null)
        setImportReceipt(null)
        setAiOpen(false)
      }}
    />
  )

  return (
    <DiaryPageFrame mode={mode} busy={busy} onClose={onClose}>
      {!desktop && (
        <p role="note" className="mb-7 rounded-md border border-border bg-muted/40 px-4 py-3 text-sm leading-relaxed text-muted-foreground">
          日记 ZIP 的导入和导出在桌面版中使用。这里可以预览页面与导出范围。
        </p>
      )}
      {mode === 'export'
        ? <ExportPage desktop={desktop} busy={busy} onBusy={setBusy} onClose={onClose} />
        : <DiaryImportContent key={nativeScan?.scanToken ?? initialArchivePath ?? 'choose'} desktop={desktop} busy={busy} receipt={importReceipt} initialScan={nativeScan} initialArchivePath={initialArchivePath} onBusy={setBusy} onClose={onClose} onExternal={(next) => { setSource(next); setImportReceipt(null); setAiOpen(true) }} onAiEntry={() => { setSource(null); setImportReceipt(null); setAiOpen(true) }} />}
    </DiaryPageFrame>
  )
}

function ExportPage({ desktop, busy, onBusy, onClose }: {
  desktop: boolean
  busy: string | null
  onBusy: (value: string | null) => void
  onClose: () => void
}) {
  const { events, flushPersistence } = useLifeStore()
  const diaries = useMemo(() => events.filter(isDailyEntry).sort((a, b) => a.date.localeCompare(b.date)), [events])
  const [scope, setScope] = useState<'all' | 'range'>('all')
  const [startDate, setStartDate] = useState(diaries[0]?.date ?? todayKey())
  const [endDate, setEndDate] = useState(diaries[diaries.length - 1]?.date ?? todayKey())
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [result, setResult] = useState<DiaryExportResult | null>(null)
  const runningRef = useRef(false)
  const rangeError = scope !== 'range' ? null : !isDiaryDate(startDate) || !isDiaryDate(endDate)
    ? '请选择完整的开始和结束日期。'
    : startDate > endDate ? '开始日期不能晚于结束日期。' : null
  const chosen = rangeError ? [] : diaries.filter((diary) => scope === 'all' || (diary.date >= startDate && diary.date <= endDate))
  const attachmentCount = new Set(chosen.flatMap((diary) => collectAttachmentIds(docForEvent(diary)))).size

  const runExport = async () => {
    if (!desktop || runningRef.current || rangeError || chosen.length === 0) return
    runningRef.current = true
    setError(null)
    setNotice(null)
    onBusy('正在保存当前编辑…')
    try {
      await flushPersistence()
      onBusy('正在选择保存位置…')
      const path = await chooseDiaryExportPath()
      if (!path) { setNotice('已取消导出。'); return }
      onBusy('正在打包日记和附件，请稍候…')
      const exported = await exportDiaries({
        destinationPath: path,
        startDate: scope === 'range' ? startDate : null,
        endDate: scope === 'range' ? endDate : null,
        overwrite: true,
      })
      setResult(exported)
    } catch (reason) {
      setError(errorText(reason, '这次导出没有完成，请重试。'))
    } finally {
      runningRef.current = false
      onBusy(null)
    }
  }

  if (result) return (
    <section aria-label="导出完成">
      <SuccessHeading title="日记已收好" />
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{result.diaryCount} 篇日记和 {result.attachmentCount} 个附件已保存为一个 ZIP 文件。</p>
      <div className="mt-7 rounded-lg border border-border p-5">
        <p className="text-xs text-muted-foreground">保存位置</p>
        <p className="mt-2 break-all text-sm select-text">{result.archivePath}</p>
        <p className="mt-3 font-mono text-xs text-muted-foreground">{formatBytes(result.byteSize)}</p>
      </div>
      <p className="mt-6 text-sm leading-relaxed text-muted-foreground">把这个 ZIP 文件带到另一台设备，在支持日记导入的 life-timeline 中选择「导入日记」即可。图片、视频和其他附件随文件一起携带。</p>
      <div className="mt-8 flex flex-wrap gap-3">
        <button type="button" className={primaryButton} onClick={onClose}>回到日记</button>
        <button type="button" className={quietButton} onClick={() => setResult(null)}>继续导出</button>
      </div>
    </section>
  )

  return (
    <section aria-label="选择导出范围">
      <h2 className="font-serif text-2xl leading-relaxed md:text-3xl">想带走哪一段日子？</h2>
      <p className="mt-3 text-sm leading-7 text-muted-foreground">正文、原有排版和引用的附件会一同打包。导出完成后，本机日记照常保留。</p>
      <fieldset disabled={Boolean(busy)} className="mt-8">
        <legend className="mb-3 text-xs tracking-wide text-muted-foreground">导出范围</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {([{ value: 'all', title: '全部日记', description: `带走已记录的 ${diaries.length} 篇日记` }, { value: 'range', title: '指定日期区间', description: '从某一天，到某一天' }] as const).map((choice) => (
            <label key={choice.value} className={cn('flex cursor-pointer items-start gap-3 rounded-lg border px-4 py-4 transition-colors hover:bg-muted/40', scope === choice.value ? 'border-primary/50 bg-primary/5' : 'border-border')}>
              <input type="radio" name="diary-export-scope" value={choice.value} checked={scope === choice.value} onChange={() => { setScope(choice.value); setError(null); setNotice(null) }} aria-label={choice.title} className="mt-1 size-3.5 accent-primary" />
              <span><span className="block text-sm">{choice.title}</span><span className="mt-1 block text-xs text-muted-foreground">{choice.description}</span></span>
            </label>
          ))}
        </div>
        {scope === 'range' && (
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-2 text-xs text-muted-foreground">开始日期<input type="date" aria-label="开始日期" value={startDate} onChange={(event) => { setStartDate(event.target.value); setError(null); setNotice(null) }} className={fieldClass} /></label>
            <label className="flex flex-col gap-2 text-xs text-muted-foreground">结束日期<input type="date" aria-label="结束日期" value={endDate} onChange={(event) => { setEndDate(event.target.value); setError(null); setNotice(null) }} className={fieldClass} /></label>
          </div>
        )}
      </fieldset>
      {scope === 'range' && <p className="mt-3 text-xs text-muted-foreground">开始和结束当天的日记都会包含在内。</p>}
      {rangeError && <p role="alert" className="mt-3 text-sm text-destructive">{rangeError}</p>}
      <div data-testid="diary-export-summary" aria-live="polite" className="mt-8 border-y border-border py-5">
        <p className="font-serif text-lg">{chosen.length} 篇日记 <span className="mx-2 text-border">/</span> <span className="text-base text-muted-foreground">{attachmentCount} 个附件</span></p>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{chosen.length > 0 ? `${chosen[0].date} — ${chosen[chosen.length - 1].date} · 图片、视频、音频及文件按原文引用收录` : '这个范围还没有日记。'}</p>
      </div>
      <p className="mt-5 text-xs leading-6 text-muted-foreground">这里只导出日记。人生节点、个人设置与其他日期的记录不在所选日记包中。</p>
      {error && <p role="alert" className="mt-5 text-sm leading-relaxed text-destructive">{error}</p>}
      {notice && <p role="status" className="mt-5 text-sm text-muted-foreground">{notice}</p>}
      <div className="mt-8 flex flex-wrap gap-3">
        <button type="button" disabled={!desktop || Boolean(busy) || Boolean(rangeError) || chosen.length === 0} onClick={() => void runExport()} className={cn(primaryButton, 'lt-hbtn inline-flex items-center gap-2')}><DiaryExportIcon className="size-4" />选择保存位置并导出</button>
        <button type="button" disabled={Boolean(busy)} onClick={onClose} className={quietButton}>取消</button>
      </div>
    </section>
  )
}

function SuccessHeading({ title }: { title: string }) {
  return <div className="flex items-center gap-3"><span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-primary/25 text-primary"><Check className="size-4" /></span><h2 className="font-serif text-2xl leading-relaxed md:text-3xl">{title}</h2></div>
}

function errorText(reason: unknown, fallback: string): string {
  if (reason instanceof Error) return reason.message || fallback
  return typeof reason === 'string' && reason.trim() ? reason : fallback
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
