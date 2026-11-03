'use client'

// 模糊时间输入:不强迫用户输入精确日期
// 编辑与新建共用。产出 { date, displayDate, datePrecision }

import { DATE_PRECISION_LABELS, type DatePrecision } from '@/types/life-event'
import { cn } from '@/lib/utils'

export interface FuzzyDateValue {
  date: string
  displayDate: string
  datePrecision: DatePrecision
}

interface FuzzyDateInputProps {
  value: FuzzyDateValue
  onChange: (value: FuzzyDateValue) => void
  /** Daily records are always one complete calendar day. Other forms retain all precisions. */
  allowedPrecisions?: readonly DatePrecision[]
  /** A date draft must retain an empty field so validation can reject it before saving. */
  allowIncomplete?: boolean
}

const PRECISIONS: DatePrecision[] = ['day', 'month', 'year', 'approx', 'stage', 'unknown']

function formatDisplay(precision: DatePrecision, date: string): string {
  const [y, m, d] = date.split('-')
  if (!y) return ''
  if (precision === 'day' && d) return `${y} 年 ${Number(m)} 月 ${Number(d)} 日`
  if (precision === 'month' && m) return `${y} 年 ${Number(m)} 月`
  if (precision === 'year') return `${y} 年`
  return ''
}

const inputClass =
  'w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-ring focus:ring-2 focus:ring-ring/30'

export function FuzzyDateInput({ value, onChange, allowedPrecisions = PRECISIONS, allowIncomplete = false }: FuzzyDateInputProps) {
  const { date, displayDate, datePrecision } = value
  const year = date.split('-')[0] ?? ''

  const setPrecision = (p: DatePrecision) => {
    if (p === datePrecision) return
    const base = date || '2016'
    const y = base.split('-')[0]
    let nextDate = base
    if (p === 'year' || p === 'approx' || p === 'stage' || p === 'unknown') nextDate = y
    if (p === 'month') nextDate = base.includes('-') ? base.split('-').slice(0, 2).join('-') : `${y}-06`
    if (p === 'day') nextDate = base.includes('-') ? (base.split('-').length === 3 ? base : `${base}-15`) : `${y}-06-15`
    const auto = formatDisplay(p, nextDate)
    const nextDisplay =
      p === 'unknown' ? '时间已记不清' : p === 'approx' ? `≈ ${y}` : auto || displayDate
    onChange({ date: nextDate, displayDate: nextDisplay, datePrecision: p })
  }

  const setDate = (nextDate: string) => {
    if (!nextDate && !allowIncomplete) return
    const auto = formatDisplay(datePrecision, nextDate)
    onChange({ ...value, date: nextDate, displayDate: auto || displayDate })
  }

  const setEstimateYear = (y: string) => {
    const clean = y.replace(/\D/g, '').slice(0, 4)
    const nextDisplay =
      datePrecision === 'approx' && /^≈ \d*$/.test(displayDate.trim()) ? `≈ ${clean}` : displayDate
    onChange({ ...value, date: clean || (allowIncomplete ? '' : '2016'), displayDate: nextDisplay })
  }

  return (
    <div className="flex flex-col gap-3">
      {/* 时间精度选择 */}
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="时间精度">
        {allowedPrecisions.map((p) => (
          <button
            key={p}
            type="button"
            role="radio"
            aria-checked={datePrecision === p}
            onClick={() => setPrecision(p)}
            className={cn(
              'rounded-full border px-3 py-1 text-xs transition-colors',
              datePrecision === p
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border text-muted-foreground hover:border-foreground/40 hover:text-foreground',
            )}
          >
            {DATE_PRECISION_LABELS[p]}
          </button>
        ))}
      </div>

      {/* 根据精度显示不同输入 */}
      {datePrecision === 'day' && (
        <input type="date" min="0001-01-01" max="9999-12-31" className={inputClass} value={date.split('-').length === 3 ? date : ''} onChange={(e) => setDate(e.target.value)} aria-label="精确日期" />
      )}
      {datePrecision === 'month' && (
        <input type="month" min="0001-01" max="9999-12" className={inputClass} value={date.split('-').slice(0, 2).join('-')} onChange={(e) => setDate(e.target.value)} aria-label="月份" />
      )}
      {datePrecision === 'year' && (
        <input
          type="text"
          inputMode="numeric"
          className={inputClass}
          value={year}
          onChange={(e) => setDate(e.target.value.replace(/\D/g, '').slice(0, 4))}
          placeholder="例如 2016"
          aria-label="年份"
        />
      )}
      {(datePrecision === 'approx' || datePrecision === 'stage' || datePrecision === 'unknown') && (
        <div className="flex flex-col gap-2">
          {datePrecision !== 'unknown' && (
            <input
              type="text"
              className={inputClass}
              value={displayDate}
              onChange={(e) => onChange({ ...value, displayDate: e.target.value })}
              placeholder={datePrecision === 'approx' ? '例如:2014 年夏天 / ≈ 2012' : '例如:小学三年级左右'}
              aria-label="时间描述"
            />
          )}
          <div className="flex items-center gap-2">
            <input
              type="text"
              inputMode="numeric"
              className={cn(inputClass, 'w-28')}
              value={year}
              onChange={(e) => setEstimateYear(e.target.value)}
              placeholder="2016"
              aria-label="估计年份"
            />
            <span className="text-xs leading-snug text-muted-foreground">
              估计年份,仅用于在时间轴上摆放位置
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
