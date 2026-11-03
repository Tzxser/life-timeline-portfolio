import type { AttachmentMeta } from '@/types/life-event'

export interface AttachmentIntakeResultOk {
  ok: true
  file: File
  kind: 'image' | 'file'
  mimeType: string
  width?: number
  height?: number
  note?: string
}

export interface AttachmentIntakeResultError {
  ok: false
  name: string
  reason: string
}

export type AttachmentIntakeResult = AttachmentIntakeResultOk | AttachmentIntakeResultError

/**
 * Metadata returned by the native attachment repository.  The relative path
 * is deliberately scoped to the application attachment directory; the
 * renderer never receives an arbitrary absolute path.
 */
export interface DesktopAttachmentRecord {
  meta: AttachmentMeta
  relativePath?: string | null
  assetUrl?: string | null
}

export type AttachmentState = 'loading' | 'ready' | 'missing' | 'error'

/**
 * A stable renderer-side snapshot.  `url` is a blob URL in the browser and a
 * controlled asset URL in the desktop shell.  It is empty while a cold-start
 * attachment is being resolved, so consumers can show a diagnostic loading
 * state without attempting to read a database or an arbitrary file path.
 */
export interface AttachmentSnapshot {
  meta: AttachmentMeta
  url: string
  status: AttachmentState
  /** Browser-only. Desktop attachments stay on disk and are not read into RAM. */
  blob?: Blob
  /** Controlled path under the native `attachments/` directory. */
  relativePath?: string
  error?: string
}

export interface AttachmentImportContext {
  /** Identity captured when the import batch was started. */
  docKey?: string
  /** Store/database epoch captured when the import batch was started. */
  epoch?: number
  /** Optional cancellation check evaluated before and after each native call. */
  isCurrent?: () => boolean
}

export interface AttachmentService {
  readonly kind: 'browser' | 'desktop'
  inspectFiles(files: File[]): Promise<AttachmentIntakeResult[]>
  commitFile(
    result: AttachmentIntakeResultOk,
    context?: AttachmentImportContext,
  ): Promise<AttachmentMeta | null>
  getAttachment(id: unknown): AttachmentSnapshot | null
  resolveAttachment(id: unknown): Promise<AttachmentSnapshot | null>
  downloadAttachment(id: unknown): Promise<void>
  saveAttachmentAs(id: unknown, targetPath?: string): Promise<boolean>
  hydrate(records: DesktopAttachmentRecord[]): Promise<void>
  subscribe(listener: () => void): () => void
  getRetainedBytes(): number
}
