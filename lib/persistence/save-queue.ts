import {
  cloneSnapshot,
  PersistenceError,
  type LifePlatform,
  type LifeSnapshot,
} from '@/lib/platform/contracts'

export type SaveQueueStatus = 'idle' | 'scheduled' | 'saving' | 'saved' | 'error'

export interface SaveQueueState {
  status: SaveQueueStatus
  revision: number
  lastSavedRevision: number
  pendingRevision: number | null
  error: string | null
}

export interface SaveQueueOptions {
  adapter: LifePlatform
  initialRevision?: number
  debounceMs?: number
  maxWaitMs?: number
  onStateChange?: (state: SaveQueueState) => void
}

interface PendingSave {
  revision: number
  snapshot: LifeSnapshot
}

const DEFAULT_DEBOUNCE_MS = 520
const DEFAULT_MAX_WAIT_MS = 1800

/**
 * Ordered, revisioned persistence queue.
 *
 * React state can update on every keystroke while this queue sends immutable
 * snapshots to the platform in order.  A late ACK can only advance the saved
 * revision; it can never replace a newer editor document or mark newer edits
 * as saved.  Failed snapshots remain pending for an explicit retry/flush.
 */
export class RevisionedSaveQueue {
  private readonly adapter: LifePlatform
  private readonly debounceMs: number
  private readonly maxWaitMs: number
  private readonly onStateChange?: (state: SaveQueueState) => void
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private maxWaitTimer: ReturnType<typeof setTimeout> | null = null
  private inFlight: Promise<void> | null = null
  private pending: PendingSave | null = null
  private disposed = false
  private nextRevision: number
  private lastSavedRevision: number
  private state: SaveQueueState

  constructor(options: SaveQueueOptions) {
    this.adapter = options.adapter
    this.debounceMs = Math.max(0, options.debounceMs ?? DEFAULT_DEBOUNCE_MS)
    this.maxWaitMs = Math.max(this.debounceMs, options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS)
    this.onStateChange = options.onStateChange
    const initialRevision = Number.isFinite(options.initialRevision)
      ? Math.max(0, Math.floor(options.initialRevision ?? 0))
      : 0
    this.nextRevision = initialRevision
    this.lastSavedRevision = initialRevision
    this.state = {
      status: 'idle',
      revision: initialRevision,
      lastSavedRevision: initialRevision,
      pendingRevision: null,
      error: null,
    }
  }

  getState(): SaveQueueState {
    return { ...this.state }
  }

  /** Queue a complete immutable state snapshot and return its assigned revision. */
  enqueue(snapshot: LifeSnapshot): number {
    if (this.disposed) throw new PersistenceError('保存队列已经关闭。', 'QUEUE_DISPOSED')
    const revision = Math.max(this.nextRevision + 1, snapshot.revision + 1)
    this.nextRevision = revision
    this.pending = { revision, snapshot: cloneSnapshot({ ...snapshot, revision }) }
    this.emit({
      status: 'scheduled',
      revision,
      lastSavedRevision: this.lastSavedRevision,
      pendingRevision: revision,
      error: null,
    })
    this.schedule()
    return revision
  }

  /** Retry a failed snapshot immediately, or flush any currently scheduled work. */
  async retry(): Promise<void> {
    await this.flush()
  }

  /**
   * Drain all pending and in-flight writes.  A rejection leaves the failed
   * immutable snapshot pending, so the caller can keep the window open and
   * offer retry/recovery instead of silently dropping the change.
   */
  async flush(): Promise<void> {
    if (this.disposed) return
    this.clearTimers()
    if (this.inFlight) {
      await this.inFlight
      // A write may have queued another snapshot while the previous one was
      // in flight.  The original drain normally handles it, but this check
      // closes a race where a callback queued work during its final turn.
      if (this.pending) await this.flush()
      return
    }
    if (!this.pending) {
      if (this.state.status === 'scheduled') {
        this.emit({ ...this.state, status: 'idle', pendingRevision: null })
      }
      return
    }

    const drain = this.drain()
    this.inFlight = drain
    try {
      await drain
    } finally {
      if (this.inFlight === drain) this.inFlight = null
    }
  }

  /** Stop timers; an already-started native write is allowed to finish safely. */
  dispose(): void {
    this.disposed = true
    this.clearTimers()
  }

  private async drain(): Promise<void> {
    while (this.pending) {
      const job = this.pending
      this.pending = null
      this.emit({
        status: 'saving',
        revision: job.revision,
        lastSavedRevision: this.lastSavedRevision,
        pendingRevision: null,
        error: null,
      })
      try {
        const ack = await this.adapter.saveSnapshot({ snapshot: job.snapshot, revision: job.revision })
        if (ack.revision < job.revision) {
          throw new PersistenceError('本机资料库确认的版本落后于当前改动。', 'STALE_ACK', ack)
        }
        this.lastSavedRevision = Math.max(this.lastSavedRevision, ack.revision)
        this.nextRevision = Math.max(this.nextRevision, ack.revision)
      } catch (cause) {
        // Preserve the failed job unless a newer snapshot was queued while it
        // was in flight.  The newer snapshot already contains the old edits.
        // TypeScript sees the property as null immediately after the local
        // job is removed; an enqueue can still happen while the await above
        // is suspended, so retain the runtime value explicitly.
        const pending = this.pending as PendingSave | null
        if (!pending || pending.revision < job.revision) this.pending = job
        const error = cause instanceof Error ? cause.message : '保存失败。'
        this.emit({
          status: 'error',
          revision: job.revision,
          lastSavedRevision: this.lastSavedRevision,
          pendingRevision: this.pending?.revision ?? null,
          error,
        })
        throw cause
      }
      if (this.pending) continue
      this.emit({
        status: 'saved',
        revision: job.revision,
        lastSavedRevision: this.lastSavedRevision,
        pendingRevision: null,
        error: null,
      })
    }
  }

  private schedule(): void {
    if (this.disposed) return
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      void this.flush().catch(() => undefined)
    }, this.debounceMs)
    if (!this.maxWaitTimer) {
      this.maxWaitTimer = setTimeout(() => {
        this.maxWaitTimer = null
        void this.flush().catch(() => undefined)
      }, this.maxWaitMs)
    }
  }

  private clearTimers(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    if (this.maxWaitTimer) clearTimeout(this.maxWaitTimer)
    this.debounceTimer = null
    this.maxWaitTimer = null
  }

  private emit(next: SaveQueueState): void {
    this.state = { ...next }
    this.onStateChange?.(this.state)
  }
}

export { DEFAULT_DEBOUNCE_MS, DEFAULT_MAX_WAIT_MS }
