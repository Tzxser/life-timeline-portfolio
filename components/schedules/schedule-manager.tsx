'use client'
import { useEffect, useRef, useState } from 'react'
import { useLifeStore } from '@/lib/life-store'
import { isAndroidRuntime } from '@/lib/platform/runtime'
import { getApiStatus, type ApiProfile } from '@/lib/ai-import'
import { invokeDesktop } from '@/lib/desktop-commands'
import { ApiManagerPage } from '@/components/diary/api-manager-page'
import { DiaryPageFrame, fieldClass, quietButton, primaryButton, errorText } from '@/components/diary/diary-page-frame'
import { ScheduleDialog } from './schedule-dialog'
import { readScheduleFile, SCHEDULE_ACCEPT, type ScheduleFileResult } from '@/lib/schedules/files'
import { parseText, parseWeeks, entryFromRecord } from '@/lib/schedules/parse'
import { addDays, cardNodes, cardView, dateKey, equal, monday, rebaseCard, schoolWeekOne, SCHEDULE_NODE, uid, validateSource, reviseSource, type ScheduleEntry, type ScheduleSource } from '@/lib/schedules/model'
import { makeScheduleUndo, rollbackSchedules, undoHasLaterChanges } from '@/lib/schedules/undo'

export function ScheduleManager({ onClose }: { onClose: () => void }) {
  const store = useLifeStore()
  const [busy, setBusy] = useState<string | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [entries, setEntries] = useState<ScheduleEntry[]>([]), [name, setName] = useState(''), [target, setTarget] = useState('')
  const [start, setStart] = useState(''), [end, setEnd] = useState(''), [weekOne, setWeekOne] = useState(''), [week, setWeek] = useState(''), [totalWeeks, setTotalWeeks] = useState('')
  const [reference, setReference] = useState(dateKey()), [source, setSource] = useState<ScheduleFileResult | null>(null)
  const [text, setText] = useState(''), [warnings, setWarnings] = useState<string[]>([]), [visible, setVisible] = useState(20)
  const [apiOpen, setApiOpen] = useState(false), [api, setApi] = useState<ApiProfile | null>(null), [askAi, setAskAi] = useState(false)
  const [confirm, setConfirm] = useState<'save' | 'undo' | null>(null)
  const abortRef = useRef<AbortController | null>(null), input = useRef<HTMLInputElement>(null), mounted = useRef(true)
  const [sendImages, setSendImages] = useState(true)
  const saving = useRef(false)
  const device = isAndroidRuntime() ? '手机' : store.platformKind === 'desktop' ? '电脑' : '浏览器预览'
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; abortRef.current?.abort() } }, [])
  const adopt = (result: { entries: ScheduleEntry[]; warnings: string[] }, filename?: string) => {
    setEntries(result.entries); setWarnings(result.warnings); setVisible(20); setTarget(''); setError(''); setNotice('')
    if (filename) setName(filename.replace(/\.[^.]+$/, ''))
    const dates = result.entries.flatMap(e => e.date ? [e.date] : []).sort()
    setStart(dates[0] || ''); setEnd(dates.at(-1) || ''); setWeekOne(dates[0] ? monday(dates[0]) : ''); setWeek('')
    const maximum = Math.max(0, ...result.entries.flatMap(e => e.weeks || []))
    setTotalWeeks(maximum ? String(maximum) : '')
  }
  const read = async (file: File) => {
    if (busy) return
    const controller = new AbortController(); abortRef.current = controller
    setBusy('正在本机读取文件…'); setError(''); setNotice(''); setAskAi(false); setSource(null); setText(''); setEntries([]); setName(''); setTarget(''); setStart(''); setEnd(''); setWeekOne(''); setWarnings([])
    try {
      const result = await readScheduleFile(file, setBusy, controller.signal)
      if (!mounted.current) return
      setSource(result); setText(result.text); adopt(result, file.name)
      setNotice(`${result.method}完成，找到 ${result.entries.length} 条安排。请核对后保存。`)
    } catch (e) { if (mounted.current) setError(errorText(e, '本地导入失败，请保留原文件。')) }
    finally { if (mounted.current) setBusy(null); abortRef.current = null; if (input.current) input.current.value = '' }
  }
  const setAnchor = (value: string, count = totalWeeks) => { setWeekOne(value); setStart(value); const n = Number(count); if (value && Number.isInteger(n) && n > 0 && n <= 52) setEnd(addDays(value, n * 7 - 1)) }
  const inspectApi = async () => {
    setError('')
    if (store.platformKind !== 'desktop') { setError('AI 接口在 Windows 和安卓应用中使用；浏览器预览仍可本地解析。'); return }
    try { const status = await getApiStatus(); const profile = status.usable ? status.profiles.find(p => p.id === status.activeProfileId) : null; setApi(profile || null); setSendImages(Boolean(profile?.supportsImages)); setAskAi(true) }
    catch (e) { setError(errorText(e, '无法读取接口配置。')) }
  }
  const analyze = async () => {
    if (!api || busy) return
    setBusy('正在使用已确认的 API 整理这份日程…'); setError('')
    try {
      const response = await invokeDesktop<{ entries: Record<string, unknown>[]; warnings: string[] }>('schedule_ai_analyze', { request: { expectedProfile: api, text: text || source?.text || '', images: sendImages ? source?.images || [] : [] } })
      if (!mounted.current) return
      const parsed = response.entries.map(entryFromRecord)
      if (parsed.some(e => !e)) throw new Error('AI 返回的部分安排缺少日期、星期或标题，请保留原文后手动补充。')
      adopt({ entries: parsed as ScheduleEntry[], warnings: response.warnings }, source?.name)
      setAskAi(false); setNotice('AI 整理完成，尚未写入日程库。请核对周次、日期和课程内容。')
    } catch (e) { if (mounted.current) setError(errorText(e, 'AI 整理失败，本地内容未改变。')) }
    finally { if (mounted.current) setBusy(null) }
  }
  const save = async () => {
    if (busy || saving.current) return
    saving.current = true; setBusy('正在保存日程…'); setError('')
    try {
      const existing = store.schedules.find(s => s.id === target)
      const recurring = entries.some(e => !e.date)
      const anchor = weekOne || (!recurring && start ? monday(start) : '')
      const assigned = new Set(entries.filter(e => existing?.entries.some(old => old.id === e.id)).map(e => e.id))
      const stableEntries = entries.map(e => {
        if (!existing || existing.entries.some(old => old.id === e.id)) return e
        const matches = existing.entries.filter(old => old.title === e.title && old.date === e.date && old.weekday === e.weekday)
        if (matches.length === 1 && !assigned.has(matches[0].id)) { assigned.add(matches[0].id); return { ...e, id: matches[0].id } }
        return e
      })
      const candidate = validateSource({ id: existing?.id || uid(), name: name.trim(), version: uid(), updatedAt: new Date().toISOString(), device, weekOne: anchor, startDate: start, endDate: end, entries: stableEntries })
      if (existing && ['name', 'weekOne', 'startDate', 'endDate', 'entries'].every(key => equal(existing[key as keyof ScheduleSource], candidate[key as keyof ScheduleSource]))) {
        setConfirm(null); setNotice('日程内容没有变化，上一次回退记录已保留。'); return
      }
      await store.flushPersistence()
      const next = existing ? reviseSource(existing, candidate, device) : candidate
      const beforeEvents = store.getEvents()
      const nextEvents = beforeEvents.map(event => {
        const content = event.richContent?.doc.content
        if (!content) return event
        const rich = event.richContent
        let changed = false
        const nextContent = content.map(node => {
          if (node.type !== SCHEDULE_NODE || !node.attrs?.card) return node
          const card = node.attrs.card as import('@/lib/schedules/model').ScheduleCard
          if (card.sourceId !== next.id) return node
          const merged = cardView(card, next)
          if (merged.conflicts.length) return node
          changed = true
          return { ...node, attrs: { ...node.attrs, card: rebaseCard(card, next, merged.grid) } }
        })
        return changed ? { ...event, richContent: { version: rich!.version, format: rich!.format, doc: { ...rich!.doc, content: nextContent } } } : event
      })
      const undo = makeScheduleUndo(existing ? [existing] : [], [next], beforeEvents, nextEvents)
      store.saveSchedules([...store.schedules.filter(s => s.id !== next.id), next], undo, nextEvents)
      await store.flushPersistence()
      setTarget(next.id); setEntries(next.entries); setConfirm(null); setNotice(`已保存「${next.name}」。关联日记会使用更新后的日程；同一项的修改冲突会单独提示。`)
    } catch (e) { setError(errorText(e, '日程保存失败。')); setConfirm(null) }
    finally { saving.current = false; if (mounted.current) setBusy(null) }
  }
  const undo = async () => {
    if (!store.scheduleUndo || busy || saving.current) return
    saving.current = true; setBusy('正在回退日程…'); setError('')
    try {
      await store.flushPersistence()
      const restored = rollbackSchedules(store.scheduleUndo, store.schedules, store.events)
      store.saveSchedules(restored.schedules, null, restored.events); await store.flushPersistence()
      setConfirm(null); setNotice('已回退上一次日程导入。普通日记文字、图片和附件保留。'); setTarget('')
    } catch (e) { setError(errorText(e, '回退失败，请保留备份。')) }
    finally { saving.current = false; if (mounted.current) setBusy(null) }
  }
  const load = (schedule: ScheduleSource) => { setTarget(schedule.id); setName(schedule.name); setEntries(structuredClone(schedule.entries)); setStart(schedule.startDate); setEnd(schedule.endDate); setWeekOne(schedule.weekOne); setWeek(''); setSource(null); setText(''); setWarnings([]); setNotice('正在编辑总日程。保存后会提示关联日记更新。'); setVisible(20) }
  const patchEntry = (id: string, patch: Partial<ScheduleEntry>) => setEntries(current => current.map(e => e.id === id ? { ...e, ...patch } : e))
  const affected = target ? cardNodes(store.events).filter(c => (c.node.attrs?.card as { sourceId?: string })?.sourceId === target).length : 0
  return <DiaryPageFrame mode="schedule" busy={busy} onClose={onClose}>
    <div className="space-y-7">
      <p className="text-sm leading-7 text-muted-foreground">文件先在本机解析。清晰图片支持离线中英文识别；复杂内容可选择你自己的 AI。识别结果由你核对后保存。</p>
      <div className="lt-schedule-actions"><button className={primaryButton} disabled={!!busy} onClick={() => input.current?.click()}>选择日程文件</button><button className={quietButton} disabled={!!busy} onClick={() => { adopt({ entries: [], warnings: [] }); setName('我的日程'); setStart(dateKey()); setEnd(dateKey()); setWeekOne(monday(dateKey())); setSource(null); setText('') }}>手动创建</button>{busy && abortRef.current && <button className={quietButton} onClick={() => abortRef.current?.abort()}>取消识别</button>}</div>
      <input ref={input} type="file" className="sr-only" accept={SCHEDULE_ACCEPT} aria-label="日程文件" onChange={e => { const file = e.target.files?.[0]; if (file) void read(file) }} />
      <p className="text-xs leading-6 text-muted-foreground">支持 TXT、Markdown、CSV、TSV、JSON、HTML、DOCX、XLSX、PDF、PNG、JPG、WebP、BMP；单个文件 ≤ 16 MB。</p>
      {store.schedules.length > 0 && <section aria-label="已导入日程"><h2 className="mb-3 font-serif text-lg">已导入的日程</h2><div className="space-y-2">{store.schedules.map(schedule => <button key={schedule.id} className="flex w-full flex-wrap justify-between gap-2 rounded-lg border border-border p-4 text-left" disabled={!!busy} onClick={() => load(schedule)}><span>{schedule.name}</span><span className="text-xs text-muted-foreground">{schedule.startDate} — {schedule.endDate} · {schedule.entries.length} 条 · {schedule.device}</span></button>)}</div></section>}
      {store.scheduleUndo && <section className="rounded-lg border border-border p-4"><p className="text-sm">可回退上次日程导入 · {new Date(store.scheduleUndo.at).toLocaleString()}</p><p className="my-2 text-xs text-muted-foreground">只保留最近一次成功导入前的状态；下一次成功导入会替换它。</p><button className={quietButton} disabled={!!busy} onClick={() => setConfirm('undo')}>回退上一次日程导入</button></section>}
      <details><summary className="cursor-pointer text-sm text-muted-foreground">粘贴文字 / 查看识别原文</summary><textarea aria-label="日程原文" value={text} onChange={e => setText(e.target.value)} maxLength={500000} rows={7} className={`${fieldClass} my-3`} /><button className={quietButton} disabled={!!busy || !text.trim()} onClick={() => { const parsed = parseText(text); adopt(parsed); setSource({ ...parsed, name: '粘贴日程', images: [], method: '本地文字解析' }); if (!name) setName('我的日程') }}>本地解析文字</button></details>
      {(source || text) && <button className={quietButton} disabled={!!busy} onClick={() => void inspectApi()}>识别不完整？选择 AI 辅助整理</button>}
      {askAi && <section aria-label="确认使用日程 AI" className="rounded-lg border border-border p-5"><h2 className="font-serif text-lg">使用 AI 辅助整理</h2>{api ? <><p className="my-3 break-words text-sm">接口：{api.name} · {api.model}<br />{api.baseUrl}</p><p className="text-sm leading-7">确认后，将本次文件提取的文字{sendImages && source?.images.length ? `及 ${source.images.length} 张图片` : ''}发送给这个接口。已有日记和其他日程不会上传。</p>{!!source?.images.length && <label className="my-3 block text-sm"><input type="checkbox" checked={sendImages} disabled={!api.supportsImages} onChange={e => setSendImages(e.target.checked)} /> 同时发送图片{!api.supportsImages && '（此接口尚未通过识图检查）'}</label>}<div className="lt-schedule-actions"><button className={primaryButton} disabled={!!busy} onClick={() => void analyze()}>确认使用这个 API</button><button className={quietButton} disabled={!!busy} onClick={() => setAskAi(false)}>继续本地编辑</button><button className={quietButton} disabled={!!busy} onClick={() => setApiOpen(true)}>选择其他 API</button></div></> : <><p className="my-3 text-sm">尚未配置可用 API。你可以配置接口，也可以继续手动填写。</p><button className={primaryButton} onClick={() => setApiOpen(true)}>配置 API</button></>}</section>}
      {name && <fieldset disabled={!!busy} className="min-w-0 space-y-5" aria-label="日程预览与编辑"><h2 className="font-serif text-xl">核对日程</h2>
        <label className="block text-sm">日程名称<input aria-label="日程名称" className={fieldClass} value={name} maxLength={200} onChange={e => setName(e.target.value)} /></label>
        <label className="block text-sm">保存位置<select aria-label="日程保存位置" className={fieldClass} value={target} onChange={e => setTarget(e.target.value)}><option value="">创建一份新日程</option>{store.schedules.map(s => <option key={s.id} value={s.id}>更新：{s.name}</option>)}</select></label>
        <div className="lt-schedule-fields"><label>适用开始日期<input type="date" aria-label="日程开始日期" className={fieldClass} value={start} onChange={e => setStart(e.target.value)} /></label><label>适用结束日期<input type="date" aria-label="日程结束日期" className={fieldClass} value={end} onChange={e => setEnd(e.target.value)} /></label></div>
        {entries.some(e => !e.date) && <fieldset className="rounded-lg border border-border p-4"><legend className="px-2 text-sm">课表与重复安排</legend><p className="mb-3 text-xs leading-6 text-muted-foreground">课表没有日期时，填写当前学校周数；系统会推算并保存第 1 周周一。以后周数自动前进，调课可编辑对应安排。</p><div className="lt-schedule-fields"><label>参考日期<input aria-label="学校周数参考日期" className={fieldClass} type="date" value={reference} onChange={e => { setReference(e.target.value); if (Number.isInteger(Number(week)) && Number(week) >= 1 && Number(week) <= 60 && e.target.value) setAnchor(schoolWeekOne(e.target.value, Number(week))) }} /></label><label>当前学校周数<input aria-label="当前学校周数" className={fieldClass} type="number" step={1} min={1} max={60} value={week} placeholder="如 7" onChange={e => { setWeek(e.target.value); const n = Number(e.target.value); if (Number.isInteger(n) && n >= 1 && n <= 60 && reference) setAnchor(schoolWeekOne(reference, n)) }} /></label><label>总周数<input aria-label="总周数" className={fieldClass} type="number" step={1} min={1} max={52} value={totalWeeks} onChange={e => { setTotalWeeks(e.target.value); if (weekOne && Number.isInteger(Number(e.target.value)) && Number(e.target.value) > 0 && Number(e.target.value) <= 52) setAnchor(weekOne, e.target.value) }} /></label><label>第 1 周周一<input aria-label="第1周周一" className={fieldClass} type="date" value={weekOne} onChange={e => setWeekOne(e.target.value)} /></label></div></fieldset>}
        {warnings.length > 0 && <div className="lt-schedule-warning" role="status">{warnings.map((warning, i) => <p key={i}>{warning}</p>)}</div>}
        <p className="text-sm text-muted-foreground">共 {entries.length} 条。日期优先于星期；仅填星期的安排按周重复。</p>
        <div className="space-y-4">{entries.slice(0, visible).map((entry, index) => <fieldset key={entry.id} className="rounded-lg border border-border p-4"><legend className="px-2 text-xs text-muted-foreground">安排 {index + 1}</legend><div className="lt-schedule-fields"><label>事项<input aria-label={`事项 ${index + 1}`} className={fieldClass} value={entry.title} onChange={e => patchEntry(entry.id, { title: e.target.value })} /></label><label>时间 / 节次<input aria-label={`时间 ${index + 1}`} className={fieldClass} value={entry.time} onChange={e => patchEntry(entry.id, { time: e.target.value })} /></label><label>具体日期<input aria-label={`日期 ${index + 1}`} className={fieldClass} type="date" value={entry.date || ''} onChange={e => patchEntry(entry.id, { date: e.target.value || undefined })} /></label><label>星期<select aria-label={`星期 ${index + 1}`} className={fieldClass} value={entry.weekday || ''} onChange={e => patchEntry(entry.id, { weekday: Number(e.target.value) || undefined, date: undefined })}><option value="">使用具体日期</option>{Array.from({ length: 7 }, (_, i) => <option key={i} value={i + 1}>星期{'一二三四五六日'[i]}</option>)}</select></label><label>周次<input aria-label={`周次 ${index + 1}`} className={fieldClass} defaultValue={entry.weeks?.join(',') || ''} placeholder="如 1-16周、1-16单周" onBlur={e => patchEntry(entry.id, { weeks: parseWeeks(e.target.value) })} /></label><label>地点<input aria-label={`地点 ${index + 1}`} className={fieldClass} value={entry.location} onChange={e => patchEntry(entry.id, { location: e.target.value })} /></label></div><label className="mt-3 block text-sm">备注<textarea aria-label={`备注 ${index + 1}`} className={fieldClass} value={entry.notes} onChange={e => patchEntry(entry.id, { notes: e.target.value })} /></label><button className={`${quietButton} mt-3`} onClick={() => setEntries(v => v.filter(e => e.id !== entry.id))}>删除这条安排</button></fieldset>)}</div>
        <div className="lt-schedule-actions">{visible < entries.length && <button className={quietButton} onClick={() => setVisible(v => v + 20)}>继续显示（剩余 {entries.length - visible} 条）</button>}<button className={quietButton} disabled={entries.length >= 4000 || !!busy} onClick={() => { setEntries(v => [...v, { id: uid(), title: '', date: start || dateKey(), time: '', location: '', notes: '' }]); setVisible(entries.length + 1) }}>增加一条安排</button><button className={primaryButton} disabled={!!busy} onClick={() => setConfirm('save')}>核对完成，保存日程</button></div>
      </fieldset>}
      {notice && <p role="status" className="text-sm leading-7">{notice}</p>}{error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
    {apiOpen && <ApiManagerPage backLabel="返回日程导入" onClose={() => { setApiOpen(false); void inspectApi() }} />}
    {confirm && <ScheduleDialog title={confirm === 'save' ? '确认保存日程' : '回退上一次日程导入'} onClose={() => { if (!saving.current) setConfirm(null) }}><p className="mb-5 leading-7">{confirm === 'save' ? target ? `更新总日程后，已有的 ${affected} 张关联日程会跟随更新。本张自定义内容保留，冲突会让用户选择。这次保存会替换上一次回退记录。` : '保存这份日程到本机。此前的回退记录会由本次导入前的状态替换。' : '恢复上次接收或导入前的日程及关联卡片。普通日记文字、图片和附件不受影响，另一台设备需要再次传输才会更新。'}</p>{confirm === 'undo' && store.scheduleUndo && undoHasLaterChanges(store.scheduleUndo, store.schedules, store.events) && <p className="lt-schedule-warning mb-5">接收后相关日程又被修改过；这些后续日程修改也会被撤销。请确认后继续。</p>}<div className="lt-schedule-actions"><button className={primaryButton} disabled={!!busy} onClick={() => void (confirm === 'save' ? save() : undo())}>{confirm === 'save' ? '确认保存' : '确认回退日程'}</button><button className={quietButton} disabled={!!busy} onClick={() => setConfirm(null)}>取消</button></div></ScheduleDialog>}
  </DiaryPageFrame>
}
