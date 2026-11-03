import type { LifeEvent } from '@/types/life-event'
import type { LifeStage } from '@/types/life-stage'

/**
 * The complete state that is safe to hand to the local persistence layer.
 *
 * The rich Tiptap document is deliberately kept intact in each event.  The
 * Rust side may derive indexes from this shape, but it must be able to return
 * the same shape without converting the document to HTML or plain text.
 */
export interface LifeSnapshot {
  schemaVersion: 1
  events: LifeEvent[]
  stages: LifeStage[]
  /** Revision last committed by the repository, when available. */
  revision: number
  /** Optional repository metadata (preferences, epoch, attachment index, ...). */
  meta?: Record<string, unknown>
}

export interface LoadSnapshotResult {
  snapshot: LifeSnapshot
  /** The repository revision is repeated here for adapters that wrap a snapshot. */
  revision: number
}

export interface SaveSnapshotRequest {
  snapshot: LifeSnapshot
  /** Monotonically increasing revision assigned by the front-end queue. */
  revision: number
}

export interface SaveSnapshotAck {
  revision: number
}

export interface FlushResult {
  revision: number
}

export type PlatformKind = 'browser' | 'desktop'

/**
 * Small, typed boundary used by React.  Components never call SQL, the file
 * system, or Tauri commands directly; the browser and desktop adapters both
 * implement this contract.
 */
export interface LifePlatform {
  readonly kind: PlatformKind
  loadSnapshot(): Promise<LoadSnapshotResult>
  saveSnapshot(request: SaveSnapshotRequest): Promise<SaveSnapshotAck>
  flush(revision?: number): Promise<FlushResult>
  /**
   * Desktop windows can ask the web UI to finish pending writes before the
   * native close request is confirmed.  Browser previews have no native
   * close handshake and simply omit this hook.
   */
  registerCloseHandler?(flush: () => Promise<void>, onError?: (error: Error) => void): () => void
  dispose?(): void
}

export class PersistenceError extends Error {
  readonly code: string
  readonly cause?: unknown

  constructor(message: string, code = 'PERSISTENCE_ERROR', cause?: unknown) {
    super(message)
    this.name = 'PersistenceError'
    this.code = code
    this.cause = cause
  }
}

export function isLifeSnapshot(value: unknown): value is LifeSnapshot {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<LifeSnapshot>
  return (
    candidate.schemaVersion === 1 &&
    Array.isArray(candidate.events) &&
    Array.isArray(candidate.stages) &&
    typeof candidate.revision === 'number' &&
    Number.isFinite(candidate.revision) &&
    candidate.revision >= 0
  )
}

/**
 * Keep adapter boundaries free of shared object identity.  In particular, the
 * database ACK must never become the editor's current Tiptap document object.
 */
export function cloneSnapshot(snapshot: LifeSnapshot): LifeSnapshot {
  const clone = typeof structuredClone === 'function'
    ? structuredClone(snapshot)
    : JSON.parse(JSON.stringify(snapshot)) as LifeSnapshot
  return clone
}

export function makeSnapshot(
  events: LifeEvent[],
  stages: LifeStage[],
  revision = 0,
  meta?: Record<string, unknown>,
): LifeSnapshot {
  return {
    schemaVersion: 1,
    events: [...events],
    stages: [...stages],
    revision,
    ...(meta ? { meta: { ...meta } } : {}),
  }
}

/**
 * Rust adapters may return the snapshot directly or wrap it in
 * `{ snapshot, revision }`.  Normalize both forms while still rejecting an
 * untyped/partial response instead of silently displaying mock data.
 */
export function normalizeLoadResult(value: unknown): LoadSnapshotResult {
  const candidate = value && typeof value === 'object' ? value as Record<string, unknown> : null
  const rawSnapshot = candidate?.snapshot ?? value
  if (!isLifeSnapshot(rawSnapshot)) {
    throw new PersistenceError('本机资料库返回了无法识别的数据。', 'INVALID_SNAPSHOT', value)
  }
  const revision = typeof candidate?.revision === 'number'
    ? candidate.revision
    : rawSnapshot.revision
  if (!Number.isFinite(revision) || revision < 0) {
    throw new PersistenceError('本机资料库返回了无效的版本号。', 'INVALID_REVISION', value)
  }
  const snapshot = cloneSnapshot({ ...rawSnapshot, revision })
  return { snapshot, revision }
}

export function normalizeSaveAck(value: unknown, fallbackRevision: number): SaveSnapshotAck {
  const candidate = value && typeof value === 'object' ? value as Record<string, unknown> : null
  const revision = typeof candidate?.revision === 'number'
    ? candidate.revision
    : typeof value === 'number'
      ? value
      : fallbackRevision
  if (!Number.isFinite(revision) || revision < 0) {
    throw new PersistenceError('本机资料库返回了无效的保存版本。', 'INVALID_ACK', value)
  }
  return { revision }
}

export function normalizeFlushResult(value: unknown, fallbackRevision: number): FlushResult {
  const candidate = value && typeof value === 'object' ? value as Record<string, unknown> : null
  const revision = typeof candidate?.revision === 'number'
    ? candidate.revision
    : typeof value === 'number'
      ? value
      : fallbackRevision
  if (!Number.isFinite(revision) || revision < 0) {
    throw new PersistenceError('本机资料库返回了无效的关闭版本。', 'INVALID_FLUSH', value)
  }
  return { revision }
}
