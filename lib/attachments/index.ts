import { useEffect, useSyncExternalStore } from 'react'
import type { AttachmentMeta } from '@/types/life-event'
import { createBrowserAttachmentService } from './browser'
import { createDesktopAttachmentService, isTauriRuntime } from './desktop'
import type {
  AttachmentImportContext,
  AttachmentIntakeResult,
  AttachmentService,
  AttachmentSnapshot,
  DesktopAttachmentRecord,
} from './types'

export type {
  AttachmentImportContext,
  AttachmentIntakeResult,
  AttachmentIntakeResultError,
  AttachmentIntakeResultOk,
  AttachmentService,
  AttachmentSnapshot,
  AttachmentState,
  DesktopAttachmentRecord,
} from './types'
export {
  BLOCKED_EXT,
  BROWSER_LIMITS,
  PREVIEWABLE_IMAGE_EXT,
  PREVIEWABLE_IMAGE_MIME,
  fileExtension,
  formatBytes,
  validateFileName,
} from './browser'

let active: AttachmentService | null = null
let version = 0
const listeners = new Set<() => void>()

function notifyVersion() {
  version++
  for (const listener of listeners) listener()
}

function service(): AttachmentService {
  if (!active) {
    active = isTauriRuntime() ? createDesktopAttachmentService() : createBrowserAttachmentService()
    active.subscribe(notifyVersion)
  }
  return active
}

/**
 * Tests and the native bootstrap can explicitly install an adapter before the
 * first read.  Production normally chooses Tauri or browser automatically.
 */
export function configureAttachmentService(next: AttachmentService | null) {
  if (active) active.subscribe(() => {})
  active = next
  if (active) active.subscribe(notifyVersion)
  notifyVersion()
}

export function attachmentServiceKind(): AttachmentService['kind'] {
  return service().kind
}

export function inspectFiles(files: File[]): Promise<AttachmentIntakeResult[]> {
  return service().inspectFiles(files)
}

export function commitFile(
  result: Extract<AttachmentIntakeResult, { ok: true }>,
  context?: AttachmentImportContext,
): Promise<AttachmentMeta | null> {
  return service().commitFile(result, context)
}

/** Stable synchronous snapshot; desktop cold-start callers should use
 * `resolveAttachment` or `useAttachment` to await the URL. */
export function getAttachment(id: unknown): AttachmentSnapshot | null {
  return service().getAttachment(id)
}

export function resolveAttachment(id: unknown): Promise<AttachmentSnapshot | null> {
  return service().resolveAttachment(id)
}

export function hydrateAttachments(records: DesktopAttachmentRecord[]): Promise<void> {
  return service().hydrate(records)
}

export function subscribeAttachments(listener: () => void): () => void {
  const unsubscribeVersion = subscribeAttachmentVersion(listener)
  return unsubscribeVersion
}

function subscribeAttachmentVersion(listener: () => void) {
  service()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getVersion() {
  service()
  return version
}

/** Re-render a NodeView/gallery when cold-start metadata or URLs arrive. */
export function useAttachmentVersion() {
  return useSyncExternalStore(subscribeAttachmentVersion, getVersion, () => 0)
}

/**
 * Async metadata/URL adapter for React consumers.  The returned snapshot is
 * stable between notifications, which avoids resetting image layout state or
 * Tiptap node views while a different attachment hydrates.
 */
export function useAttachment(id: unknown): AttachmentSnapshot | null {
  const key = typeof id === 'string' ? id : null
  useAttachmentVersion()
  const snapshot = key ? getAttachment(key) : null
  useEffect(() => {
    if (!key) return
    void resolveAttachment(key)
  }, [key])
  return snapshot
}

export function downloadAttachment(id: unknown): Promise<void> {
  return service().downloadAttachment(id)
}

export function saveAttachmentAs(id: unknown, targetPath?: string): Promise<boolean> {
  return service().saveAttachmentAs(id, targetPath)
}

export function getRetainedAttachmentBytes() {
  return service().getRetainedBytes()
}

