'use client'

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { DATE_PRECISION_LABELS, isDailyEntry, type LifeEvent } from '@/types/life-event'
import type { LifeStage } from '@/types/life-stage'
import { dateEditPatch, eventDateValue, hasDateChange, validateDateEdit, type EventDateValue } from '@/lib/date-edit'
import { registerOverlay } from '@/lib/overlay-registry'
import { FuzzyDateInput } from './fuzzy-date-input'

interface EventDateEditorProps {
  event: LifeEvent
  stage: LifeStage | null
  events: readonly LifeEvent[]
  onChange: (patch: Partial<LifeEvent>) => void
}

interface DateDraft {
  original: EventDateValue
  value: EventDateValue
}

/** A modal in the browser's top layer cannot inherit the writing article's transform. */
function DateAdjustmentDialog({
  original,
  draft,
  error,
  onConfirm,
  onDiscard,
  onContinue,
}: {
  original: EventDateValue
  draft: EventDateValue
  error: string | null
  onConfirm: () => void
  onDiscard: () => void
  onContinue: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const descriptionId = useId()

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialog.showModal()
    const release = registerOverlay()
    return () => {
      dialog.close()
      document.body.style.overflow = previousOverflow
      release()
    }
  }, [])

  return createPortal(
    <dialog
      ref={dialogRef}
      aria-label="确认调整时间"
      aria-describedby={descriptionId}
      aria-modal="true"
      onCancel={(e) => {
        e.preventDefault()
        onContinue()
      }}
      onClick={(e) => {
        if (e.target !== e.currentTarget) return
        const rect = e.currentTarget.getBoundingClientRect()
        if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) onContinue()
      }}
      className="fixed inset-0 m-auto w-[calc(100%_-_2rem)] max-w-md rounded-xl border border-border bg-background p-6 text-foreground shadow-xl backdrop:bg-foreground/20"
    >
      <h2 className="font-serif text-xl">确认调整时间？</h2>
      <p id={descriptionId} className="mt-3 text-sm leading-relaxed text-muted-foreground">
        确认后，这篇记录会按新的时间排列。正文和图片会保留。
      </p>
      <dl className="mt-5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-3 text-sm">
        <dt className="text-muted-foreground">原时间</dt>
        <dd>
          <span>{original.displayDate}</span>
          <span className="mt-1 block font-mono text-xs text-muted-foreground">{DATE_PRECISION_LABELS[original.datePrecision]} · {original.date}</span>
        </dd>
        <dt className="text-muted-foreground">调整为</dt>
        <dd>
          <span>{draft.displayDate || '尚未填写'}</span>
          <span className="mt-1 block font-mono text-xs text-muted-foreground">{DATE_PRECISION_LABELS[draft.datePrecision]} · {draft.date || '尚未填写'}</span>
        </dd>
      </dl>
      {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
      <div className="mt-6 flex flex-wrap justify-end gap-2">
        <button type="button" onClick={onDiscard} className="rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">放弃调整</button>
        <button type="button" autoFocus onClick={onContinue} className="rounded-md border border-border px-3 py-2 text-sm transition-colors hover:bg-muted">继续编辑</button>
        <button type="button" disabled={Boolean(error)} onClick={onConfirm} className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40">确认调整</button>
      </div>
    </dialog>,
    document.body,
  )
}

/** Date edits are a local draft. Only an explicit confirmation changes the saved event. */
export function EventDateEditor({ event, stage, events, onChange }: EventDateEditorProps) {
  const [draft, setDraft] = useState<DateDraft | null>(null)
  const [confirming, setConfirming] = useState(false)
  const areaRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const swallowClickRef = useRef(false)
  const editing = draft !== null
  const changed = draft !== null && hasDateChange(draft.original, draft.value)
  const error = draft && hasDateChange(draft.original, eventDateValue(event))
    ? '这篇记录的时间已更新，请放弃本次调整后重新编辑。'
    : draft ? validateDateEdit(event, draft.value, events) : null

  const close = useCallback((restoreFocus: boolean) => {
    setConfirming(false)
    setDraft(null)
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }))
  }, [])

  const requestClose = useCallback((restoreFocus: boolean) => {
    if (changed) setConfirming(true)
    else close(restoreFocus)
  }, [changed, close])

  useEffect(() => {
    if (!editing) return
    areaRef.current?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true })
  }, [editing])

  useEffect(() => {
    if (!draft) return
    const isOutside = (target: EventTarget | null) => target instanceof Node && !areaRef.current?.contains(target)
    const block = (e: Event) => {
      e.preventDefault()
      e.stopImmediatePropagation()
    }
    const onPointerDown = (e: PointerEvent) => {
      // A new gesture clears an old suppressed click when a browser did not emit it.
      swallowClickRef.current = false
      if (confirming || e.button !== 0 || !isOutside(e.target)) return
      if (changed) {
        block(e)
        swallowClickRef.current = true
      }
      requestClose(false)
    }
    const onClick = (e: MouseEvent) => {
      if (swallowClickRef.current) {
        swallowClickRef.current = false
        block(e)
        return
      }
      // Keyboard and assistive-technology clicks do not necessarily have pointerdown.
      if (confirming || !isOutside(e.target)) return
      if (changed) block(e)
      requestClose(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (confirming || e.isComposing) return
      if (e.key === 'Escape') {
        block(e)
        requestClose(true)
      } else if ((e.key === 'Enter' || e.key === ' ') && isOutside(e.target)) {
        if (changed) block(e)
        requestClose(false)
      }
    }
    // Capture before timeline/navigation handlers so a date draft cannot be lost by switching documents.
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('click', onClick, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('click', onClick, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [draft, confirming, changed, requestClose])

  const confirm = () => {
    if (!draft || error) return
    if (changed) onChange(dateEditPatch(event, draft.value))
    close(true)
  }

  return (
    <div ref={areaRef} className="flex min-h-7 flex-wrap items-center gap-x-2 gap-y-1" data-date-editor>
      {draft ? (
        <div className="flex flex-col gap-2 py-1">
          <FuzzyDateInput
            value={draft.value}
            allowedPrecisions={isDailyEntry(event) ? ['day'] : undefined}
            allowIncomplete
            onChange={(value) => setDraft({ ...draft, value })}
          />
          {error && !confirming && <p role="alert" className="text-xs text-destructive">{error}</p>}
          <button type="button" onClick={() => requestClose(true)} className="self-start text-xs text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline">收起时间</button>
        </div>
      ) : (
        <button
          ref={triggerRef}
          type="button"
          onClick={() => {
            const original = eventDateValue(event)
            setDraft({ original, value: original })
          }}
          title="点击修改时间"
          aria-label="点击修改时间"
          aria-expanded={false}
          className="-mx-1.5 rounded px-1.5 py-0.5 font-mono text-xs tracking-widest text-muted-foreground tabular-nums transition-colors hover:bg-muted hover:text-foreground"
        >
          {event.displayDate}
        </button>
      )}
      {stage && !draft && (
        <span className="font-serif text-xs text-muted-foreground/70"><span className="mr-2 opacity-50">·</span>{stage.name}</span>
      )}
      {draft && confirming && <DateAdjustmentDialog original={draft.original} draft={draft.value} error={error} onConfirm={confirm} onDiscard={() => close(true)} onContinue={() => setConfirming(false)} />}
    </div>
  )
}
