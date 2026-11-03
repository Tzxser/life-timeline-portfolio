'use client'

import { Minus, Plus } from 'lucide-react'

interface TimelineControlsProps {
  zoom: number
  onZoomIn: () => void
  onZoomOut: () => void
  onGoToNow: () => void
}

export function TimelineControls({ zoom, onZoomIn, onZoomOut, onGoToNow }: TimelineControlsProps) {
  return (
    <div className="flex items-center gap-1 rounded-full border border-border/80 bg-background/90 px-1.5 py-1 shadow-sm backdrop-blur-sm">
      <button
        type="button"
        onClick={onZoomOut}
        className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        aria-label="缩小时间轴"
      >
        <Minus className="size-3.5" />
      </button>
      <span className="w-12 text-center font-mono text-xs text-muted-foreground tabular-nums">
        {Math.round(zoom * 100)}%
      </span>
      <button
        type="button"
        onClick={onZoomIn}
        className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        aria-label="放大时间轴"
      >
        <Plus className="size-3.5" />
      </button>
      <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
      <button
        type="button"
        onClick={onGoToNow}
        className="rounded-full px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        现在
      </button>
    </div>
  )
}
