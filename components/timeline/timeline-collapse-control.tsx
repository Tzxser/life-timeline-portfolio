'use client'

import { ChevronsDown, ChevronsUp } from 'lucide-react'

export type TimelineCollapseControlPlacement = 'divider' | 'stage'

interface TimelineCollapseControlProps {
  placement: TimelineCollapseControlPlacement
  onClick: () => void
}

/**
 * The timeline divider stays quiet until the writing view is in focus.  A
 * small icon on the existing rule keeps the action discoverable without
 * adding a second row of text to the diary page.  The stage variant reuses
 * the same rule immediately below the “全部” stage navigation row.
 */
export function TimelineCollapseControl({ placement, onClick }: TimelineCollapseControlProps) {
  const isStageControl = placement === 'stage'
  const label = isStageControl ? '释放时间轴' : '收起时间轴'
  const Icon = isStageControl ? ChevronsUp : ChevronsDown

  return (
    <div
      className={`lt-timeline-collapse-control ${isStageControl ? 'lt-timeline-collapse-control-stage' : 'lt-timeline-collapse-control-divider'}`}
      data-timeline-collapse-control={placement}
    >
      {isStageControl && <span aria-hidden="true" className="lt-timeline-collapse-line" />}
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        title={label}
        className="lt-timeline-collapse-button"
      >
        <Icon aria-hidden="true" className="lt-timeline-collapse-icon" />
        <span className="sr-only">{label}</span>
      </button>
      {isStageControl && <span aria-hidden="true" className="lt-timeline-collapse-line" />}
    </div>
  )
}
