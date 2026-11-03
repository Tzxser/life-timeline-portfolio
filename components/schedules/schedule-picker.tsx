'use client'
import { useState } from 'react'
import { useLifeStore } from '@/lib/life-store'
import { addDays, dateKey, makeCard, monday, type ScheduleCard } from '@/lib/schedules/model'
import { ScheduleDialog } from './schedule-dialog'
import { fieldClass, primaryButton, quietButton } from '@/components/diary/diary-page-frame'

export function SchedulePicker({ diaryDate, onInsert, onClose, onManage }: { diaryDate?: string; onInsert: (card: ScheduleCard) => void; onClose: () => void; onManage: () => void }) {
  const { schedules } = useLifeStore()
  const [id, setId] = useState(schedules[0]?.id || '')
  const [start, setStart] = useState(diaryDate || dateKey()), [end, setEnd] = useState(diaryDate || dateKey())
  const [view, setView] = useState<ScheduleCard['view']>('list')
  const [error, setError] = useState('')
  const day = (value: string) => { setStart(value); setEnd(value); setView('list') }
  return <ScheduleDialog title="插入日程" onClose={onClose}><div className="space-y-5">
    <p className="text-sm text-muted-foreground">插入到这篇日记末尾。每次插入都是独立的一张，可以分别编辑。</p>
    {!schedules.length ? <p>还没有日程，请先导入或手动创建。</p> : <>
      <label className="block text-sm">日程来源<select aria-label="日程来源" className={`${fieldClass} mt-2`} value={id} onChange={e => setId(e.target.value)}>{schedules.map(source => <option key={source.id} value={source.id}>{source.name}</option>)}</select></label>
      <div className="lt-schedule-actions"><button className={quietButton} onClick={() => day(dateKey())}>今天</button><button className={quietButton} onClick={() => day(addDays(dateKey(), 1))}>明天</button>{diaryDate && <button className={quietButton} onClick={() => day(diaryDate)}>本篇日期</button>}<button className={quietButton} onClick={() => { const start = monday(diaryDate || dateKey()); setStart(start); setEnd(addDays(start, 6)); setView('week') }}>本周</button><button className={quietButton} onClick={() => { const s = schedules.find(s => s.id === id); if (s) { setStart(s.startDate); setEnd(s.endDate); setView('list') } }}>整个日程范围</button></div>
      <div className="lt-schedule-fields"><label>开始日期<input aria-label="插入开始日期" className={fieldClass} type="date" value={start} onChange={e => { setStart(e.target.value); if (e.target.value > end) setEnd(e.target.value) }} /></label><label>结束日期<input aria-label="插入结束日期" className={fieldClass} type="date" value={end} onChange={e => setEnd(e.target.value)} /></label></div>
      <label className="block text-sm">展示方式<select aria-label="展示方式" className={fieldClass} value={view} onChange={e => setView(e.target.value as ScheduleCard['view'])}><option value="list">逐日日程列表</option><option value="week">周课表（最多七天）</option></select></label>
      {view === 'week' && <p className="text-xs text-muted-foreground">手机上可左右滑动查看一周的每天。</p>}
      <button className={primaryButton} onClick={() => { try { const source = schedules.find(s => s.id === id); if (source) onInsert(makeCard(source, start, end, view)) } catch (e) { setError(e instanceof Error ? e.message : '无法插入日程') } }}>插入到日记末尾</button>
    </>}
    {error && <p role="alert">{error}</p>}
    <button className={quietButton} onClick={onManage}>导入或管理日程</button>
  </div></ScheduleDialog>
}
