import type {
  LifePlatform,
  LifeSnapshot,
  LoadSnapshotResult,
  SaveSnapshotAck,
  SaveSnapshotRequest,
  FlushResult,
} from './contracts'
import { cloneSnapshot, makeSnapshot, normalizeSaveAck } from './contracts'
import type { LifeEvent } from '@/types/life-event'
import type { LifeStage } from '@/types/life-stage'

/**
 * Browser preview adapter.
 *
 * The web preview intentionally remains an in-memory experience.  It starts
 * with the R3 mock data, keeps edits alive while the provider is mounted, and
 * never pretends that a browser save reached a disk.  The desktop adapter is
 * selected only when Tauri is actually present.
 */
export class BrowserLifePlatform implements LifePlatform {
  readonly kind = 'browser' as const
  private snapshot: LifeSnapshot

  constructor(initial?: { events?: LifeEvent[]; stages?: LifeStage[]; revision?: number }) {
    this.snapshot = makeSnapshot(
      initial?.events ?? [],
      initial?.stages ?? [],
      initial?.revision ?? 0,
    )
  }

  async loadSnapshot(): Promise<LoadSnapshotResult> {
    // Keep the async boundary identical to desktop so callers cannot depend
    // on synchronous state updates in the browser preview.
    await Promise.resolve()
    const snapshot = cloneSnapshot(this.snapshot)
    return { snapshot, revision: snapshot.revision }
  }

  async saveSnapshot(request: SaveSnapshotRequest): Promise<SaveSnapshotAck> {
    await Promise.resolve()
    // A stale request is ignored just like the SQLite repository would ignore
    // an old revision.  The caller's queue normally serializes these anyway.
    if (request.revision < this.snapshot.revision) {
      return { revision: this.snapshot.revision }
    }
    this.snapshot = cloneSnapshot({ ...request.snapshot, revision: request.revision })
    return normalizeSaveAck({ revision: request.revision }, request.revision)
  }

  async flush(revision = this.snapshot.revision): Promise<FlushResult> {
    await Promise.resolve()
    return { revision: Math.max(revision, this.snapshot.revision) }
  }

  registerCloseHandler(): () => void {
    return () => undefined
  }
}
