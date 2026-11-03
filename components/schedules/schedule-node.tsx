'use client'
import { useEffect, useRef, useState } from 'react'
import { Node, NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react'
import { CalendarDays, MoreHorizontal } from 'lucide-react'
import { useLifeStore } from '@/lib/life-store'
import { SCHEDULE_NODE, validCard, cardView, rebaseCard, scheduleText, type GridChoices, type ScheduleCard } from '@/lib/schedules/model'
import { ScheduleGridView } from './schedule-grid'
import { ScheduleDialog } from './schedule-dialog'
import { primaryButton, quietButton } from '@/components/diary/diary-page-frame'
import { registerOverlay } from '@/lib/overlay-registry'

export const LifeSchedule = Node.create({
  name: SCHEDULE_NODE, group: 'block', atom: true, draggable: false, selectable: true,
  addAttributes() { return { card: { default: null, rendered: false } } },
  parseHTML() { return [] },
  renderHTML() { return ['section', { 'data-life-schedule': '' }, '日程'] },
  renderText({ node }) { return validCard(node.attrs.card) ? scheduleText(node.attrs.card) : '' },
  addNodeView() { return ReactNodeViewRenderer(ScheduleView) },
})

function ScheduleView({ node, updateAttributes, deleteNode }: ReactNodeViewProps) {
  const { schedules } = useLifeStore()
  const [menu, setMenu] = useState(false)
  const [editing, setEditing] = useState(false)
  const [choices, setChoices] = useState<GridChoices>({})
  const actions = useRef<HTMLDivElement>(null)
  const menuButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!menu) return
    const release = registerOverlay()
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return
      event.preventDefault()
      event.stopPropagation()
      setMenu(false)
      menuButton.current?.focus({ preventScroll: true })
    }
    const outside = (event: PointerEvent) => {
      const target = event.target as globalThis.Node | null
      if (!actions.current?.contains(target) && !menuButton.current?.contains(target)) setMenu(false)
    }
    // The card lives inside ProseMirror, whose keyboard handling runs before
    // document bubbling. Capture Back/Escape while this action menu is open.
    document.addEventListener('keydown', dismiss, true)
    document.addEventListener('pointerdown', outside)
    return () => { release(); document.removeEventListener('keydown', dismiss, true); document.removeEventListener('pointerdown', outside) }
  }, [menu])
  const card = node.attrs.card as ScheduleCard
  if (!validCard(card)) return <NodeViewWrapper contentEditable={false}><p role="alert">日程数据无法显示，请保留备份。</p></NodeViewWrapper>
  const source = schedules.find(s => s.id === card.sourceId)
  const result = cardView(card, source)
  const patch = (next: ScheduleCard) => updateAttributes({ card: next })
  const resolve = () => {
    const resolved = cardView(card, source, choices)
    if (!resolved.conflicts.length) { patch(rebaseCard(card, source, resolved.grid)); setChoices({}) }
  }
  return <NodeViewWrapper contentEditable={false} className={`lt-schedule-card lt-schedule-${card.layout}`} data-schedule-id={card.id} data-view={card.view === 'list' && !result.grid.merges.length ? 'list' : 'week'} onContextMenu={(e: React.MouseEvent) => { e.preventDefault(); setMenu(true) }}>
    <div className="lt-schedule-card-heading"><CalendarDays size={16} /><span>{source?.name || card.sourceName}</span><button ref={menuButton} type="button" aria-label="日程操作" aria-expanded={menu} onClick={() => setMenu(v => !v)}><MoreHorizontal size={20} /></button></div>
    <p className="lt-schedule-date">{card.startDate}{card.endDate !== card.startDate ? ` 至 ${card.endDate}` : ''}</p>
    {menu && <div ref={actions} className="lt-schedule-actions" role="group" aria-label="日程布局与编辑">{(['bottom', 'left', 'right'] as const).map((layout, i) => <button type="button" key={layout} className={quietButton} onClick={() => { patch({ ...card, layout }); setMenu(false) }}>{['放在下方', '放在左侧', '放在右侧'][i]}</button>)}<button className={quietButton} onClick={() => { setEditing(true); setMenu(false) }}>编辑表格</button><button className={quietButton} onClick={deleteNode}>移除这一张</button></div>}
    {result.conflicts.length > 0 && <button className="lt-schedule-warning" onClick={() => setEditing(true)}>总日程更新与本张修改有 {result.conflicts.length} 处冲突，点击选择版本</button>}
    {!source && <p className="text-xs text-muted-foreground">来源已移除，保留本张日程内容。</p>}
    {source && source.version !== card.sourceVersion && result.conflicts.length === 0 && <p className="text-xs text-muted-foreground">已跟随总日程更新；本张自定义内容保留。</p>}
    <ScheduleGridView grid={result.grid} limit={12} />
    <button className="mt-3 text-xs text-muted-foreground underline underline-offset-4" onClick={() => setEditing(true)}>展开与编辑</button>
    {editing && <ScheduleDialog title={`${card.sourceName} · 当前日程`} onClose={() => { setEditing(false); setChoices({}) }}>
      <p className="mb-4 text-sm text-muted-foreground">这里的增删行列和内容修改只影响当前这一张日程。总日程的其他更新仍会同步到这里。</p>
      {result.conflicts.length > 0 ? <div className="space-y-4"><p>请先处理总日程更新与本张修改的冲突。</p>{result.conflicts.map(conflict => <fieldset key={conflict.id} className="rounded-md border border-border p-3"><legend className="px-2 text-sm">{conflict.label}</legend><label className="mb-2 block text-sm"><input type="radio" name={`${card.id}:${conflict.id}`} checked={choices[conflict.id] === 'local'} onChange={() => setChoices(c => ({ ...c, [conflict.id]: 'local' }))} /> 保留本张：{conflict.local}</label><label className="block text-sm"><input type="radio" name={`${card.id}:${conflict.id}`} checked={choices[conflict.id] === 'incoming'} onChange={() => setChoices(c => ({ ...c, [conflict.id]: 'incoming' }))} /> 采用总表：{conflict.incoming}</label></fieldset>)}<div className="lt-schedule-actions"><button className={quietButton} onClick={() => setChoices(Object.fromEntries(result.conflicts.map(c => [c.id, 'local'])))}>全部保留本张</button><button className={quietButton} onClick={() => setChoices(Object.fromEntries(result.conflicts.map(c => [c.id, 'incoming'])))}>全部采用总表</button><button disabled={result.conflicts.some(c => !choices[c.id])} className={primaryButton} onClick={resolve}>确认选择</button></div></div>
        : <ScheduleGridView grid={result.grid} onChange={grid => patch(rebaseCard(card, source, grid))} />}
    </ScheduleDialog>}
  </NodeViewWrapper>
}
