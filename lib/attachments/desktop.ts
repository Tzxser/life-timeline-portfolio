import type { AttachmentMeta } from '@/types/life-event'
import { save as nativeSaveDialog } from '@tauri-apps/plugin-dialog'
import { isAndroidRuntime } from '@/lib/platform/runtime'
import {
  BLOCKED_EXT,
  BROWSER_LIMITS,
  createBrowserAttachmentService,
  fileExtension,
  validateFileName,
  type BrowserIntakeResultOk,
} from './browser'
import type {
  AttachmentImportContext,
  AttachmentService,
  AttachmentSnapshot,
  DesktopAttachmentRecord,
} from './types'

type Invoke = <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>

interface TauriGlobal {
  core?: { invoke?: Invoke }
  /** Tauri v1/compatibility global used by a few test shells. */
  invoke?: Invoke
  dialog?: {
    save?: (options?: Record<string, unknown>) => Promise<string | null>
  }
}

interface TauriInternals {
  invoke?: Invoke
}

function globals(): { tauri: TauriGlobal | null; internals: TauriInternals | null } {
  if (typeof globalThis === 'undefined') return { tauri: null, internals: null }
  const root = globalThis as typeof globalThis & {
    __TAURI__?: TauriGlobal
    __TAURI_INTERNALS__?: TauriInternals
  }
  return { tauri: root.__TAURI__ ?? null, internals: root.__TAURI_INTERNALS__ ?? null }
}

/** Tauri v2's JS API is intentionally optional for the web bundle. */
export function isTauriRuntime(): boolean {
  const { tauri, internals } = globals()
  if (tauri?.core?.invoke || tauri?.invoke || internals?.invoke) return true
  if (typeof window === 'undefined') return false
  const { protocol, hostname } = window.location
  if (protocol === 'tauri:' || protocol === 'asset:') return true
  if (hostname === 'tauri.localhost' || hostname.endsWith('.tauri.localhost')) return true
  return typeof navigator !== 'undefined' && /\btauri\b/i.test(navigator.userAgent)
}

async function invokeNative<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { tauri, internals } = globals()
  const invoke = tauri?.core?.invoke ?? tauri?.invoke ?? internals?.invoke
  if (invoke) return invoke<T>(command, args)
  try {
    const core: unknown = await import('@tauri-apps/api/core')
    const dynamicInvoke = (core as { invoke?: Invoke }).invoke
    if (typeof dynamicInvoke === 'function') return dynamicInvoke<T>(command, args)
  } catch {
    // Fall through to the stable user-facing error below.
  }
  throw new Error('本地附件服务不可用:当前页面不在 life-timeline 桌面窗口中')
}

function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 512) return false
  const normalized = value.replaceAll('\\', '/')
  if (normalized !== value || normalized.startsWith('/') || /^[a-zA-Z]:/.test(value)) return false
  const parts = normalized.split('/')
  if (parts[0] !== 'attachments' || parts.some((part) => !part || part === '.' || part === '..')) return false
  // The native service controls the hash filename.  The renderer only accepts
  // the attachment tree, never a database/config/backup path.
  if (parts.length < 2 || parts.length > 4) return false
  return true
}

function isControlledAssetUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 4096) return false
  return (
    value.startsWith('asset://localhost/') || value.startsWith('http://asset.localhost/')
  )
}

function asMeta(value: unknown): AttachmentMeta | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<AttachmentMeta>
  if (
    typeof raw.id !== 'string' ||
    typeof raw.name !== 'string' ||
    typeof raw.mimeType !== 'string' ||
    typeof raw.byteSize !== 'number' ||
    (raw.kind !== 'image' && raw.kind !== 'file')
  ) {
    return null
  }
  const nameError = validateFileName(raw.name)
  if (nameError || BLOCKED_EXT.has(fileExtension(raw.name))) return null
  if (!Number.isSafeInteger(raw.byteSize) || raw.byteSize <= 0) return null
  return {
    id: raw.id,
    name: raw.name,
    mimeType: raw.mimeType,
    byteSize: raw.byteSize,
    kind: raw.kind,
    width: typeof raw.width === 'number' ? raw.width : undefined,
    height: typeof raw.height === 'number' ? raw.height : undefined,
    lastModified: typeof raw.lastModified === 'number' ? raw.lastModified : undefined,
  }
}

function recordFromUnknown(value: unknown): DesktopAttachmentRecord | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const rawMeta = (record.meta && typeof record.meta === 'object' ? record.meta : value) as Record<string, unknown>
  const meta = asMeta(rawMeta)
  if (!meta) return null
  // Native list_attachments returns a flattened AttachmentMeta while
  // import_attachment/attachment_path return an envelope. Accept both shapes,
  // but only accept a URL that the native boundary supplied.
  const relativePath = record.relativePath ?? rawMeta.relativePath
  const assetUrl = record.assetUrl ?? rawMeta.assetUrl
  if (relativePath !== undefined && relativePath !== null && !isSafeRelativePath(relativePath)) return null
  if (assetUrl !== undefined && assetUrl !== null && !isControlledAssetUrl(assetUrl)) return null
  return {
    meta,
    relativePath: typeof relativePath === 'string' ? relativePath : null,
    assetUrl: typeof assetUrl === 'string' ? assetUrl : null,
  }
}

function isCurrent(context?: AttachmentImportContext) {
  return !context?.isCurrent || context.isCurrent()
}

class DesktopAttachmentService implements AttachmentService {
  readonly kind = 'desktop' as const
  private readonly entries = new Map<string, AttachmentSnapshot>()
  private readonly listeners = new Set<() => void>()
  private readonly resolving = new Set<string>()
  /** Reuse only the browser's validation/decode pipeline; no browser Map is used. */
  private readonly validator = createBrowserAttachmentService()

  async inspectFiles(files: File[]) {
    return this.validator.inspectFiles(files)
  }

  async commitFile(result: BrowserIntakeResultOk, context?: AttachmentImportContext): Promise<AttachmentMeta | null> {
    if (!isCurrent(context)) return null
    const fileName = result.file.name || '未命名文件'
    const nameError = validateFileName(fileName)
    const ext = fileExtension(fileName)
    if (nameError || BLOCKED_EXT.has(ext) || result.file.size <= 0) return null
    const itemLimit = result.kind === 'image' ? BROWSER_LIMITS.imageMaxBytes : BROWSER_LIMITS.fileMaxBytes
    if (result.file.size > itemLimit) return null
    if (!isTauriRuntime()) throw new Error('本地附件服务不可用:无法将文件保存到桌面资料库')

    // Uint8Array is passed as binary-shaped IPC data (never a base64 string).
    // The native command enforces the same byte and path boundaries again.
    const buffer = await result.file.arrayBuffer()
    if (!isCurrent(context)) return null
    const bytes = Array.from(new Uint8Array(buffer))
    const response = await invokeNative<unknown>('import_attachment', {
      request: {
        name: fileName,
        mimeType: result.mimeType,
        kind: result.kind,
        lastModified: result.file.lastModified || null,
        width: result.width ?? null,
        height: result.height ?? null,
        bytes,
      },
    })
    if (!isCurrent(context)) return null

    const record = recordFromUnknown(response)
    if (!record) throw new Error('本地附件服务返回了无效的附件元数据')
    this.setRecord(record)
    // If the command did not include an asset URL, resolve only the small path
    // metadata now; the renderer still never reads the file bytes itself.
    if (this.entries.get(record.meta.id)?.status !== 'ready') void this.resolveAttachment(record.meta.id)
    return record.meta
  }

  getAttachment(id: unknown): AttachmentSnapshot | null {
    return typeof id === 'string' ? this.entries.get(id) ?? null : null
  }

  async resolveAttachment(id: unknown): Promise<AttachmentSnapshot | null> {
    if (typeof id !== 'string' || !id) return null
    const current = this.entries.get(id)
    if (!current) return null
    if (current.status === 'ready' && current.url) return current
    if (this.resolving.has(id)) return current

    const pending: AttachmentSnapshot = { ...current, status: 'loading', error: undefined }
    this.entries.set(id, pending)
    this.notify()
    this.resolving.add(id)
    try {
      let relativePath = current.relativePath
      // Always ask native for the URL when the snapshot did not include one.
      // A cold-start snapshot may carry only the logical relative path, and
      // constructing an asset URL in JS is incorrect on Windows.
      const response = await invokeNative<unknown>('attachment_path', { request: { id } })
      if (response && typeof response === 'object') {
        const value = response as Record<string, unknown>
        relativePath = typeof value.relativePath === 'string' ? value.relativePath : relativePath
        const nativeUrl = value.assetUrl
        if (isControlledAssetUrl(nativeUrl)) {
          const ready: AttachmentSnapshot = {
            ...pending,
            relativePath,
            url: nativeUrl,
            status: 'ready',
            error: undefined,
          }
          this.entries.set(id, ready)
          this.notify()
          return ready
        }
      }
      if (!relativePath || !isSafeRelativePath(relativePath)) throw new Error('附件路径不在受控目录中')
      // The native command must return the platform-specific asset URL.  The
      // renderer deliberately does not reconstruct one from a relative path:
      // on Windows Tauri requires the encoded absolute path form.
      throw new Error('本地附件服务未返回受控资源 URL')
    } catch (error) {
      const failed: AttachmentSnapshot = {
        ...pending,
        status: 'error',
        error: error instanceof Error ? error.message : '附件资源无法读取',
      }
      this.entries.set(id, failed)
      this.notify()
      return failed
    } finally {
      this.resolving.delete(id)
    }
  }

  async downloadAttachment(id: unknown): Promise<void> {
    await this.saveAttachmentAs(id)
  }

  async saveAttachmentAs(id: unknown, targetPath?: string): Promise<boolean> {
    const entry = await this.resolveAttachment(id)
    if (!entry || entry.status !== 'ready' || typeof id !== 'string') return false
    let target = targetPath
    if (!target) {
      try {
        // Use the Tauri dialog plugin rather than a global compatibility
        // object. The plugin returns the user-selected absolute path; only
        // that transient path crosses back into the native save command.
        target = (await nativeSaveDialog({
          defaultPath: entry.meta.name,
          title: '保存附件',
        })) ?? undefined
        if (!target && isAndroidRuntime()) return false
      } catch (cause) {
        // Android file access is user-mediated by SAF. A denied/failed picker
        // must not silently open a second browser download path.
        if (isAndroidRuntime()) throw cause
        // A minimal test shell may not register the plugin. Keep the
        // controlled asset URL fallback below for that environment.
        target = undefined
      }
    }
    if (target) {
      const result = await invokeNative<unknown>('save_attachment_as', {
        request: { id, targetPath: target },
      })
      if (typeof result === 'boolean') return result
      if (result && typeof result === 'object' && 'ok' in result) return !!(result as { ok?: unknown }).ok
      return true
    }
    // Global dialog APIs are optional in a minimal Tauri build.  Falling back
    // to the controlled asset URL preserves the old browser interaction while
    // never exposing a filesystem path to the page.
    if (typeof document !== 'undefined' && entry.url) {
      const a = document.createElement('a')
      a.href = entry.url
      a.download = entry.meta.name
      a.rel = 'noopener'
      document.body.appendChild(a)
      a.click()
      a.remove()
      return true
    }
    return false
  }

  async hydrate(records: DesktopAttachmentRecord[]): Promise<void> {
    for (const input of records) {
      const record = recordFromUnknown(input)
      if (record) {
        // Hydration records can originate from the persisted snapshot. Do not
        // trust an URL that was serialized there; ask the native command for a
        // fresh scoped URL below, even when a stale assetUrl field is present.
        this.setRecord({ ...record, assetUrl: null }, false)
      }
    }
    this.notify()
    // Hydrating metadata is cheap; resolving asset URLs does not load entire
    // files and lets the gallery update after a cold start.
    await Promise.all(
      [...this.entries.values()]
        .filter((entry) => entry.status !== 'ready')
        .map((entry) => this.resolveAttachment(entry.meta.id)),
    )
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getRetainedBytes() {
    // Native files are not held in renderer memory.  Returning zero keeps the
    // old API meaningful without turning the browser's 200 MiB cache budget
    // into a lifetime desktop-library quota.
    return 0
  }

  private setRecord(record: DesktopAttachmentRecord, notify = true) {
    const relativePath = record.relativePath ?? undefined
    const assetUrl = record.assetUrl && isControlledAssetUrl(record.assetUrl) ? record.assetUrl : ''
    this.entries.set(record.meta.id, {
      meta: record.meta,
      relativePath,
      url: assetUrl,
      status: assetUrl ? 'ready' : 'loading',
    })
    if (notify) this.notify()
  }

  private notify() {
    for (const listener of this.listeners) listener()
  }
}

export function createDesktopAttachmentService() {
  return new DesktopAttachmentService()
}
