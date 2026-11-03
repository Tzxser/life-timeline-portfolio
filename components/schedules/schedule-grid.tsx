'use client'
import { useEffect, useRef, useState } from 'react'
import { clone, uid, type ScheduleGrid } from '@/lib/schedules/model'
import { fieldClass, quietButton, primaryButton } from '@/components/diary/diary-page-frame'

export function ScheduleGridView({ grid, onChange, limit = 100 }: { grid: ScheduleGrid; onChange?: (grid: ScheduleGrid) => void; limit?: number }) {
  const [selected, setSelected] = useState<{ row: string; column: string } | null>(null)
  const [draft, setDraft] = useState('')
  const [merging, setMerging] = useState(false)
  const [visible, setVisible] = useState(limit)
  const [error, setError] = useState('')
  const cellEditor = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (!selected) return
    let frame: number | null = null
    const reveal = (focus: boolean) => {
      if (frame !== null) window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        frame = null
        const input = cellEditor.current
        if (!input || (!focus && document.activeElement !== input)) return
        input.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        if (focus) input.focus({ preventScroll: true })
      })
    }
    const resize = () => reveal(false)
    reveal(true)
    // The Android keyboard reduces the WebView after focus, so keep this
    // input in view when the visible viewport changes without stealing focus.
    window.addEventListener('resize', resize, { passive: true })
    window.visualViewport?.addEventListener('resize', resize, { passive: true })
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', resize)
      window.visualViewport?.removeEventListener('resize', resize)
    }
  }, [selected])
  const edit = (update: (value: ScheduleGrid) => void) => { const value = clone(grid); update(value); onChange?.(value); setError('') }
  const select = (row: string, column: string) => {
    if (merging && selected) {
      const rows = [grid.rows.findIndex(r => r.id === selected.row), grid.rows.findIndex(r => r.id === row)].sort((a, b) => a - b)
      const columns = [grid.columns.findIndex(c => c.id === selected.column), grid.columns.findIndex(c => c.id === column)].sort((a, b) => a - b)
      const rowIds = grid.rows.slice(rows[0], rows[1] + 1).map(r => r.id), colIds = grid.columns.slice(columns[0], columns[1] + 1).map(c => c.id)
      if (grid.merges.some(m => m.rows.some(id => rowIds.includes(id)) && m.columns.some(id => colIds.includes(id)))) setError('请先拆分重叠的合并单元格。')
      else edit(g => { g.merges.push({ rows: rowIds, columns: colIds }) })
      setMerging(false); return
    }
    setSelected({ row, column }); setDraft(grid.rows.find(r => r.id === row)?.cells[column] || '')
  }
  const active = selected && grid.rows.some(r => r.id === selected.row) && grid.columns.some(c => c.id === selected.column) ? selected : null
  const saveCell = (text: string) => {
    if (!active || (grid.rows.find(row => row.id === active.row)?.cells[active.column] || '') === text) return
    edit(value => { value.rows.find(row => row.id === active.row)!.cells[active.column] = text })
  }
  return <div className="lt-schedule-sheet">
    {onChange && <div className="lt-schedule-actions">
      <button className={quietButton} disabled={grid.rows.length >= 4000} onClick={() => edit(g => { const index = active ? g.rows.findIndex(r => r.id === active.row) + 1 : g.rows.length; g.rows.splice(index, 0, { id: `custom:${uid()}`, cells: {} }); setVisible(v => Math.max(v, index + 1)) })}>增加行</button>
      <button className={quietButton} disabled={!active} onClick={() => edit(g => { g.rows = g.rows.filter(r => r.id !== active!.row); g.merges = g.merges.filter(m => !m.rows.includes(active!.row)); setSelected(null) })}>删除行</button>
      <button className={quietButton} disabled={grid.columns.length >= 64} onClick={() => edit(g => { g.columns.push({ id: `custom:${uid()}`, label: '新栏目' }) })}>增加列</button>
      <button className={quietButton} disabled={!active || grid.columns.length <= 1} onClick={() => edit(g => { g.columns = g.columns.filter(c => c.id !== active!.column); g.rows.forEach(r => { delete r.cells[active!.column] }); g.merges = g.merges.filter(m => !m.columns.includes(active!.column)); setSelected(null) })}>删除列</button>
      <button className={quietButton} disabled={!active} aria-pressed={merging} onClick={() => setMerging(v => !v)}>{merging ? '取消合并选择' : '合并范围'}</button>
      <button className={quietButton} disabled={!active} onClick={() => edit(g => { g.merges = g.merges.filter(m => !(m.rows.includes(active!.row) && m.columns.includes(active!.column))) })}>拆分单元格</button>
    </div>}
    {merging && <p role="status" className="text-sm text-muted-foreground">已选定起点，请点合并范围的另一个角。各格文字会保留，拆分后恢复。</p>}
    {error && <p role="alert">{error}</p>}
    <div className="lt-schedule-scroll" tabIndex={0} aria-label="日程表格，可横向滚动">
      <table aria-label="日程表格"><thead><tr>{grid.columns.map(column => <th scope="col" key={column.id}>{onChange ? <input aria-label={`栏目名称 ${column.label}`} value={column.label} onChange={e => edit(g => { g.columns.find(c => c.id === column.id)!.label = e.target.value })} maxLength={200} /> : column.label}</th>)}</tr></thead>
        <tbody>{grid.rows.slice(0, visible).map(row => <tr key={row.id}>{grid.columns.map(column => {
          const merge = grid.merges.find(m => m.rows.includes(row.id) && m.columns.includes(column.id))
          if (merge && (merge.rows[0] !== row.id || merge.columns[0] !== column.id)) return null
          const text = merge ? merge.rows.flatMap(id => merge.columns.map(col => grid.rows.find(r => r.id === id)?.cells[col] || '')).filter(Boolean).join('\n') : row.cells[column.id] || ''
          return <td key={column.id} data-label={column.label} rowSpan={merge?.rows.length} colSpan={merge?.columns.length} data-selected={active?.row === row.id && active.column === column.id ? 'true' : undefined}>{onChange ? <button type="button" aria-label={`编辑 ${column.label} ${text.slice(0, 30) || '空白'}`} onClick={() => select(row.id, column.id)}>{text || <span className="text-muted-foreground/40">—</span>}</button> : text || '—'}</td>
        })}</tr>)}</tbody>
      </table>
      {grid.rows.length === 0 && <p className="p-5 text-sm text-muted-foreground">这个日期范围还没有安排。{onChange ? '点击“增加行”添加自己的安排。' : '点击下方“展开与编辑”添加自己的安排。'}</p>}
    </div>
    {grid.rows.length > visible && <button className={quietButton} onClick={() => setVisible(v => v + 100)}>继续显示（剩余 {grid.rows.length - visible} 行）</button>}
    {onChange && active && <div className="mt-4 space-y-3"><label className="block text-sm">编辑选中单元格<textarea ref={cellEditor} aria-label="单元格内容" className={`${fieldClass} lt-schedule-cell-editor mt-2`} rows={3} value={draft} maxLength={8000} onChange={e => setDraft(e.target.value)} onBlur={e => saveCell(e.currentTarget.value)} /></label><button className={primaryButton} onClick={() => saveCell(draft)}>保存单元格</button><p className="text-xs text-muted-foreground">离开输入框时自动保存，只影响当前这一张日程。</p></div>}
  </div>
}
