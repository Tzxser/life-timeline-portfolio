'use client'

import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ChevronRight, FileText, Images, Paperclip } from 'lucide-react'
import { AiDiaryIcon, ApiManagerIcon } from '@/components/common/header-icons'
import {
  getApiStatus, chooseExternalSources, inspectAiSources, analyzeAiSources, buildAiArchive, discardAiImport,
  type ApiStatus, type AiSourceSummary, type AiPreview, type AiEntryEdit,
} from '@/lib/ai-import'
import { isDiaryDate, type DiaryScanResult } from '@/lib/diary-transfer'
import { useLifeStore } from '@/lib/life-store'
import { cn } from '@/lib/utils'
import { ApiManagerPage } from './api-manager-page'
import { DiaryImportContent } from './diary-import-content'
import { DiaryPageFrame, quietButton, primaryButton, fieldClass, errorText } from './diary-page-frame'

export function AiImportPage({ initialSource, onClose, onNativeArchive }: {
  initialSource?: AiSourceSummary | null
  onClose: () => void
  onNativeArchive: (archivePath: string) => Promise<void>
}) {
  const { platformKind, flushPersistence } = useLifeStore()
  const desktop = platformKind === 'desktop'
  const [source, setSource] = useState<AiSourceSummary | null>(initialSource ?? null)
  const [preview, setPreview] = useState<AiPreview | null>(null)
  const [edits, setEdits] = useState<AiEntryEdit[]>([])
  const [scan, setScan] = useState<DiaryScanResult | null>(null)
  const [step, setStep] = useState<'source' | 'preview' | 'review'>('source')
  const [apiStatus, setApiStatus] = useState<ApiStatus>({ profiles: [], activeProfileId: null, usable: false })
  const [apiOpen, setApiOpen] = useState(false)
  const [apiRefresh, setApiRefresh] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [apiError, setApiError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const running = useRef(false)
  const activeProfile = apiStatus.profiles.find((profile) => profile.id === apiStatus.activeProfileId)
  const usable = apiStatus.usable && Boolean(activeProfile)
  const needsVision = Boolean(source?.requiresVision && !activeProfile?.supportsImages)
  const invalidDates = edits.filter((entry) => !isDiaryDate(entry.date)).length
  const invalidTitles = edits.some((entry) => !entry.title.trim())
  const reviewHeading = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    if (!desktop) return
    let alive = true
    setApiError(null)
    void getApiStatus().then((status) => { if (alive) setApiStatus(status) })
      .catch((reason) => { if (alive) { setApiStatus({ profiles: [], activeProfileId: null, usable: false }); setApiError(errorText(reason, '接口状态暂时不可用，请打开管理 API 检查。')) } })
    return () => { alive = false }
  }, [desktop, apiRefresh])

  useEffect(() => { if (step === 'preview') reviewHeading.current?.focus({ preventScroll: false }) }, [step])

  const selectSources = async () => {
    if (!desktop || running.current) return
    running.current = true
    setError(null)
    setNotice(null)
    setBusy('正在选择日记、文档或照片…')
    try {
      const paths = await chooseExternalSources()
      if (!paths?.length) { setNotice('已取消选择，当前内容保持原样。'); return }
      setBusy('正在本机检查文件内容与附件，不会发送给 AI…')
      const inspected = await inspectAiSources(paths)
      if (source) await discardAiImport(source.sessionId)
      if (inspected.kind === 'native') { await onNativeArchive(inspected.archivePath); return }
      setSource(inspected.source)
      setPreview(null)
      setEdits([])
      setScan(null)
      setStep('source')
    } catch (reason) { setError(errorText(reason, '这些文件暂时无法读取，请查看提示后重新选择。')) }
    finally { running.current = false; setBusy(null) }
  }

  const analyze = async () => {
    if (!desktop || !source || !usable || !activeProfile || needsVision || running.current) return
    running.current = true
    setError(null)
    setNotice(null)
    setBusy('正在将选中的内容交给所选 AI 整理，原有日记保持不变…')
    try {
      const result = await analyzeAiSources(source.sessionId, activeProfile)
      setPreview(result)
      setEdits(result.entries.map((entry) => ({ id: entry.id, date: entry.date ?? '', title: entry.title, transcribedText: entry.transcribedText })))
      setScan(null)
      setStep('preview')
    } catch (reason) { setError(errorText(reason, '这次整理没有完成。可检查接口或更换文件后重试，已有日记没有改变。')) }
    finally { running.current = false; setBusy(null) }
  }

  const build = async () => {
    if (!desktop || !source || !preview || edits.length === 0 || invalidDates > 0 || invalidTitles || running.current) return
    running.current = true
    setError(null)
    setNotice(null)
    setBusy('正在保存当前编辑并检查日期冲突…')
    try {
      await flushPersistence()
      const result = await buildAiArchive(source.sessionId, edits.map((entry) => ({ ...entry, title: entry.title.trim() })))
      setScan(result)
      setStep('review')
    } catch (reason) { setError(errorText(reason, '暂时无法生成导入预览，请检查日期与标题后重试。')) }
    finally { running.current = false; setBusy(null) }
  }

  const discardAndClose = async () => {
    if (running.current || busy) return
    if (!source) { onClose(); return }
    running.current = true
    setError(null)
    setBusy('正在清理本次整理草稿…')
    try { await discardAiImport(source.sessionId); onClose() }
    catch (reason) { setError(errorText(reason, '整理草稿暂时无法清理，请重试。原文件和日记没有改变。')) }
    finally { running.current = false; setBusy(null) }
  }

  const updateEntry = (id: string, patch: Partial<AiEntryEdit>) => {
    setEdits((current) => current.map((entry) => entry.id === id ? { ...entry, ...patch } : entry))
    setScan(null)
    setError(null)
  }

  return (
    <>
      <DiaryPageFrame mode="ai" busy={busy} onClose={() => void discardAndClose()} backLabel="返回导入页面，放弃未导入的整理草稿">
        {!desktop && <p role="note" className="mb-7 rounded-md border border-border bg-muted/40 px-4 py-3 text-sm leading-7 text-muted-foreground">文件检查、接口配置与 AI 整理在桌面版中使用。这里可以预览页面。</p>}
        {step === 'review' && source && scan
          ? <DiaryImportContent key={scan.scanToken} desktop={desktop} busy={busy} receipt={null} onBusy={setBusy} onClose={() => void discardAndClose()} aiReview={{ sessionId: source.sessionId, scan, onBack: () => { setStep('preview'); setError(null) }, onRecheck: build }} />
          : step === 'preview' && preview ? (
            <section aria-label="AI 整理结果预览">
              <p className="mb-3 font-mono text-xs tracking-wide text-muted-foreground">02 / 核对整理结果</p>
              <h2 ref={reviewHeading} tabIndex={-1} className="font-serif text-2xl leading-relaxed outline-none md:text-3xl">每一段记忆，由你确认</h2>
              <p className="mt-3 text-sm leading-7 text-muted-foreground">「{preview.profileName}」整理出 {preview.entries.length} 篇日记。请核对日期、标题和照片识别文字。文档原文保留，日期不明的内容需要你补全。</p>
              <p className="mt-2 text-xs leading-6 text-muted-foreground">结果尚未写入日记库。下一步还会检查与本机日记的日期冲突，并再次请你确认。</p>
              <p className="mt-2 text-xs leading-6 text-muted-foreground">多篇填写同一日期时，会按原来源顺序合成一篇，使用第一篇的标题，并保留全部正文和附件。</p>
              <Warnings items={preview.warnings} />
              <div className="mt-7 space-y-5">
                {preview.entries.map((entry, index) => {
                  const edit = edits.find((value) => value.id === entry.id)
                  if (!edit) return null
                  return <fieldset key={entry.id} disabled={Boolean(busy)} className="rounded-lg border border-border p-4 sm:p-5">
                    <legend className="px-1 font-mono text-xs text-muted-foreground">日记 {String(index + 1).padStart(2, '0')}</legend>
                    <p className="break-words text-xs leading-6 text-muted-foreground">来源：{entry.sourceNames.join('、')}</p>
                    <div className="mt-4 grid gap-4 sm:grid-cols-[180px_1fr]">
                      <label className="block text-xs text-muted-foreground">日期<input type="date" aria-label={`第${index + 1}篇日记日期`} value={edit.date} onChange={(event) => updateEntry(entry.id, { date: event.target.value })} aria-invalid={!isDiaryDate(edit.date)} className={cn(fieldClass, 'mt-2 font-mono')} />{!isDiaryDate(edit.date) && <span className="mt-2 block text-destructive">请补全这篇日记的日期。</span>}</label>
                      <label className="block text-xs text-muted-foreground">标题<input aria-label={`第${index + 1}篇日记标题`} value={edit.title} onChange={(event) => updateEntry(entry.id, { title: event.target.value })} maxLength={300} className={cn(fieldClass, 'mt-2')} /></label>
                    </div>
                    <details className="mt-4" open={preview.entries.length <= 3}>
                      <summary className="cursor-pointer text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">查看原文摘录与附件数量</summary>
                      <p className="mt-3 max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted/30 p-3 text-sm leading-7">{entry.textPreview || '这篇主要来自照片，原图会作为附件保留。'}</p>
                      <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground"><Paperclip className="size-3" />{entry.attachmentCount} 个附件会随正文保留</p>
                    </details>
                    {entry.canEditTranscription && <label className="mt-4 block text-xs text-muted-foreground">照片识别文字<textarea aria-label={`第${index + 1}篇照片识别文字`} value={edit.transcribedText} onChange={(event) => updateEntry(entry.id, { transcribedText: event.target.value })} rows={6} className={cn(fieldClass, 'mt-2 min-h-32 resize-y leading-7')} /><span className="mt-2 block leading-6">可修正识别错误；照片原文件也会保留。请核对 AI 可能误读或补出的内容。</span></label>}
                  </fieldset>
                })}
              </div>
              {invalidDates > 0 && <p role="status" className="mt-5 text-sm text-muted-foreground">还有 {invalidDates} 篇日记需要填写完整日期。</p>}
              {invalidTitles && <p role="status" className="mt-3 text-sm text-muted-foreground">请为每篇日记保留一个标题。</p>}
              <div className="mt-8 flex flex-wrap gap-3">
                <button type="button" disabled={!desktop || Boolean(busy) || edits.length === 0 || invalidDates > 0 || invalidTitles} onClick={() => void build()} className={cn(primaryButton, 'inline-flex items-center gap-1.5')}>下一步：检查日期冲突<ChevronRight className="size-4" /></button>
                <button type="button" disabled={Boolean(busy)} onClick={() => { setStep('source'); setError(null) }} className={quietButton}>返回来源／重新整理</button>
                <button type="button" disabled={Boolean(busy)} onClick={() => void discardAndClose()} className={quietButton}>放弃整理并返回</button>
              </div>
            </section>
          ) : (
            <section aria-label="选择 AI 导入来源">
              <p className="mb-3 font-mono text-xs tracking-wide text-muted-foreground">01 / 先查看来源</p>
              <h2 className="font-serif text-2xl leading-relaxed md:text-3xl">旧纸页，也能接回时间线</h2>
              <p className="mt-3 text-sm leading-7 text-muted-foreground">从外部日记、文本或一组照片开始。先在本机检查文件，再由你决定是否请 AI 帮忙辨认日期、分篇和识别照片文字。</p>
              <div className="mt-7 rounded-xl border border-dashed border-border px-5 py-7">
                <div className="flex items-start gap-4"><span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted/50 text-muted-foreground"><Images className="size-5" /></span><div><h3 className="font-serif text-lg">{source ? source.sourceLabel : '选择一份旧日记，或一组照片'}</h3><p className="mt-2 text-xs leading-6 text-muted-foreground">支持 Markdown、TXT、HTML、JSON、照片，以及包含这些文件和附件的 ZIP。其他格式会明确提示，不会猜着丢掉内容。</p></div></div>
                <button type="button" disabled={!desktop || Boolean(busy)} onClick={() => void selectSources()} className={cn(quietButton, 'mt-5 inline-flex items-center gap-2')}><FileText className="size-4" />{source ? '重新选择文件' : '选择文档或照片'}</button>
              </div>
              {source && <>
                <dl aria-label="本机来源摘要" className="mt-6 grid grid-cols-2 gap-4 border-y border-border py-5 sm:grid-cols-4">
                  {([['文档', source.documentCount], ['图片', source.imageCount], ['附件', source.attachmentCount], ['文字', source.textCharacterCount]] as const).map(([label, count]) => <div key={label}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-2 font-serif text-xl">{count}<span className="ml-1 text-xs text-muted-foreground">{label === '文字' ? '字' : '个'}</span></dd></div>)}
                </dl>
                <p className="mt-3 text-xs text-muted-foreground">文件已在本机读取，尚未发送给 AI，也没有修改日记库。</p>
                <Warnings items={source.warnings} />
                {source.samples.length > 0 && <details className="mt-5 rounded-lg border border-border"><summary className="cursor-pointer px-4 py-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">查看来源摘录（{source.samples.length} 项）</summary><ul className="max-h-96 overflow-y-auto border-t border-border px-4">{source.samples.map((sample) => <li key={sample.id} className="border-b border-border/60 py-4 last:border-0"><p className="break-words text-xs text-muted-foreground">{sample.sourceName}</p>{sample.thumbnailDataUrl && <span className="mt-3 block h-36 w-48 max-w-full rounded-md border border-border bg-contain bg-center bg-no-repeat" style={{ backgroundImage: `url(${JSON.stringify(sample.thumbnailDataUrl)})` }} role="img" aria-label={`${sample.sourceName} 来源预览`} />}{sample.textPreview && <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-7">{sample.textPreview}</p>}</li>)}</ul></details>}
              </>}
              <div className="mt-7 rounded-lg border border-border bg-muted/20 p-5">
                <h3 className="font-serif text-lg">{usable && activeProfile ? `使用「${activeProfile.name}」` : '先添加一个可用的 AI 接口'}</h3>
                {usable && activeProfile ? <><p className="mt-2 break-all font-mono text-xs leading-6 text-muted-foreground">{activeProfile.model}<br />{activeProfile.baseUrl}</p><p className="mt-2 text-xs text-muted-foreground">{activeProfile.supportsImages ? '已通过文字与图片检查' : '已通过文字检查；图片识别尚未通过检查'}</p></> : <p className="mt-2 text-sm leading-7 text-muted-foreground">在「管理 API」填写你自己的接口与密钥，保存并应用成功后再继续。当前选择的文件会留在这里。</p>}
                {needsVision && usable && <p role="note" className="mt-3 text-sm leading-7 text-destructive">这批来源包含需要识别文字的照片，请应用一个支持图片识别的模型。</p>}
                {apiError && <p role="alert" className="mt-3 text-sm leading-7 text-destructive">{apiError}</p>}
                <button type="button" disabled={Boolean(busy)} onClick={() => setApiOpen(true)} className={cn(quietButton, 'lt-hbtn mt-4 inline-flex items-center gap-2')}><ApiManagerIcon className="size-4" />管理 API</button>
              </div>
              <div className="mt-6 border-l-2 border-primary/25 pl-4 text-sm leading-7 text-muted-foreground"><p>点击「开始 AI 整理」后，所选文件中用于整理的文字和图片会发送到上面显示的接口。请确认你愿意交由该服务处理；已有日记库不会随之上传。</p><p className="mt-2">AI 结果需要你核对并再次确认才会写入。现在可以返回，导入完成后也可在没有后续修改时一键回退。</p></div>
              <div className="mt-8 flex flex-wrap gap-3">
                <button type="button" disabled={!desktop || !source || !usable || needsVision || Boolean(busy)} onClick={() => void analyze()} className={cn(primaryButton, 'lt-hbtn inline-flex items-center gap-2')}><AiDiaryIcon className="size-4" />开始 AI 整理</button>
                <button type="button" disabled={Boolean(busy)} onClick={() => void discardAndClose()} className={cn(quietButton, 'inline-flex items-center gap-1.5')}><ArrowLeft className="size-3.5" />返回导入，不发送</button>
                {preview && <button type="button" disabled={Boolean(busy)} onClick={() => setStep('preview')} className={quietButton}>继续查看上次结果</button>}
              </div>
            </section>
          )}
        {error && <p role="alert" className="mt-5 text-sm leading-7 text-destructive">{error}</p>}
        {notice && <p role="status" className="mt-5 text-sm leading-7 text-muted-foreground">{notice}</p>}
      </DiaryPageFrame>
      {apiOpen && <ApiManagerPage backLabel="返回 AI 辅助导入" onClose={() => { setApiOpen(false); setApiRefresh((value) => value + 1) }} />}
    </>
  )
}

function Warnings({ items }: { items: string[] }) {
  return items.length ? <div role="note" className="mt-5 rounded-lg border border-border bg-muted/30 px-4 py-3 text-sm leading-7 text-muted-foreground">{items.map((warning, index) => <p key={index}>{warning}</p>)}</div> : null
}
