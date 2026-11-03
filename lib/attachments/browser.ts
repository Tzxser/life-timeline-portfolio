import type { AttachmentMeta } from '@/types/life-event'
import type {
  AttachmentImportContext,
  AttachmentService,
  AttachmentSnapshot,
  DesktopAttachmentRecord,
} from './types'

const MiB = 1024 * 1024

/** R3 protection limits.  These are an in-memory browser budget, not a
 * lifetime limit for a persisted desktop library. */
export const BROWSER_LIMITS = {
  imageMaxBytes: 10 * MiB,
  fileMaxBytes: 50 * MiB,
  batchMax: 10,
  sessionMaxBytes: 200 * MiB,
} as const

export const PREVIEWABLE_IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
export const PREVIEWABLE_IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif'])

/** Executable/script host formats are always rejected. */
export const BLOCKED_EXT = new Set([
  'exe',
  'msi',
  'msp',
  'bat',
  'cmd',
  'com',
  'scr',
  'pif',
  'cpl',
  'ps1',
  'vbs',
  'vbe',
  'wsf',
  'wsh',
  'hta',
  'jar',
  'apk',
  'app',
])

export interface BrowserIntakeResultOk {
  ok: true
  file: File
  kind: 'image' | 'file'
  mimeType: string
  width?: number
  height?: number
  /** 给用户看的补充说明,例如“暂不支持图片预览” */
  note?: string
}

export interface BrowserIntakeResultError {
  ok: false
  name: string
  reason: string
}

export type BrowserIntakeResult = BrowserIntakeResultOk | BrowserIntakeResultError

export function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/**
 * Keep the original display name while refusing path-bearing or control
 * names.  Browser File objects normally contain only a basename, but drag and
 * drop implementations are not required to do so.
 */
export function validateFileName(name: string): string | null {
  if (!name || name === '.' || name === '..') return '文件名为空或无效'
  if (name.length > 255) return '文件名过长(最多 255 个字符)'
  if (/[\\/\u0000-\u001f\u007f]/.test(name)) return '文件名不能包含路径分隔符或控制字符'
  return null
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < MiB) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / MiB).toFixed(1)} MB`
}

function newAttachmentId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return `att-${crypto.randomUUID()}`
  return `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** Decode once to obtain dimensions and reject corrupt image data. */
async function decodeImage(file: File): Promise<{ width: number; height: number }> {
  if (typeof URL === 'undefined' || typeof Image === 'undefined') {
    throw new Error('当前环境不能解码图片')
  }
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    if (!img.naturalWidth || !img.naturalHeight) throw new Error('empty image')
    return { width: img.naturalWidth, height: img.naturalHeight }
  } finally {
    URL.revokeObjectURL(url)
  }
}

function isCurrent(context?: AttachmentImportContext) {
  return !context?.isCurrent || context.isCurrent()
}

class BrowserAttachmentService implements AttachmentService {
  readonly kind = 'browser' as const
  private readonly entries = new Map<string, AttachmentSnapshot>()
  private retainedBytes = 0
  private readonly listeners = new Set<() => void>()

  async inspectFiles(files: File[]): Promise<BrowserIntakeResult[]> {
    const results: BrowserIntakeResult[] = []
    let pendingBytes = 0

    for (const [index, file] of files.entries()) {
      const name = file?.name || '未命名文件'
      if (index >= BROWSER_LIMITS.batchMax) {
        results.push({ ok: false, name, reason: `单次最多添加 ${BROWSER_LIMITS.batchMax} 个文件` })
        continue
      }

      const nameError = validateFileName(name)
      if (nameError) {
        results.push({ ok: false, name, reason: nameError })
        continue
      }
      const ext = fileExtension(name)
      if (BLOCKED_EXT.has(ext)) {
        results.push({ ok: false, name, reason: `出于安全考虑,可执行程序(.${ext})不能作为附件添加` })
        continue
      }
      if (file.size === 0) {
        results.push({ ok: false, name, reason: '文件为空(0 字节)' })
        continue
      }

      const mimeType = file.type || 'application/octet-stream'
      const previewable = PREVIEWABLE_IMAGE_MIME.has(mimeType) || (!file.type && PREVIEWABLE_IMAGE_EXT.has(ext))
      const limit = previewable ? BROWSER_LIMITS.imageMaxBytes : BROWSER_LIMITS.fileMaxBytes
      if (file.size > limit) {
        results.push({
          ok: false,
          name,
          reason: `${previewable ? '图片' : '文件'}超过 ${formatBytes(limit)} 上限(实际 ${formatBytes(file.size)})`,
        })
        continue
      }
      // This budget only accounts for browser-held blobs.  Persisted desktop
      // files are not loaded into the renderer and are therefore unaffected.
      if (this.retainedBytes + pendingBytes + file.size > BROWSER_LIMITS.sessionMaxBytes) {
        results.push({
          ok: false,
          name,
          reason: `本次会话的附件合计已接近 ${formatBytes(BROWSER_LIMITS.sessionMaxBytes)} 上限`,
        })
        continue
      }

      if (previewable) {
        try {
          const { width, height } = await decodeImage(file)
          results.push({ ok: true, file, kind: 'image', mimeType, width, height })
          pendingBytes += file.size
        } catch {
          results.push({ ok: false, name, reason: '图片无法解码,文件可能已损坏' })
        }
        continue
      }

      const isOtherImage =
        mimeType.startsWith('image/') || ['heic', 'heif', 'bmp', 'tif', 'tiff', 'avif', 'svg'].includes(ext)
      results.push({
        ok: true,
        file,
        kind: 'file',
        mimeType,
        note: isOtherImage ? '暂不支持图片预览,可下载原文件' : undefined,
      })
      pendingBytes += file.size
    }
    return results
  }

  async commitFile(
    result: BrowserIntakeResultOk,
    context?: AttachmentImportContext,
  ): Promise<AttachmentMeta | null> {
    if (!isCurrent(context)) return null
    const { file } = result
    if (this.retainedBytes + file.size > BROWSER_LIMITS.sessionMaxBytes) return null
    const nameError = validateFileName(file.name || '未命名文件')
    if (nameError || BLOCKED_EXT.has(fileExtension(file.name))) return null
    const meta: AttachmentMeta = {
      id: newAttachmentId(),
      name: file.name || '未命名文件',
      mimeType: result.mimeType,
      byteSize: file.size,
      kind: result.kind,
      width: result.width,
      height: result.height,
      lastModified: file.lastModified,
    }
    const url = URL.createObjectURL(file)
    this.entries.set(meta.id, { meta, blob: file, url, status: 'ready' })
    this.retainedBytes += file.size
    this.notify()
    return isCurrent(context) ? meta : null
  }

  getAttachment(id: unknown): AttachmentSnapshot | null {
    return typeof id === 'string' ? this.entries.get(id) ?? null : null
  }

  async resolveAttachment(id: unknown): Promise<AttachmentSnapshot | null> {
    return this.getAttachment(id)
  }

  async downloadAttachment(id: unknown): Promise<void> {
    const entry = this.getAttachment(id)
    if (!entry || entry.status !== 'ready' || !entry.url || typeof document === 'undefined') return
    const a = document.createElement('a')
    a.href = entry.url
    a.download = entry.meta.name
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  async saveAttachmentAs(id: unknown): Promise<boolean> {
    const entry = this.getAttachment(id)
    if (!entry || entry.status !== 'ready') return false
    await this.downloadAttachment(id)
    return true
  }

  async hydrate(_records: DesktopAttachmentRecord[]): Promise<void> {
    // Browser mode has no durable index.  This is intentionally a no-op so a
    // shared repository loader can hydrate whichever adapter is active.
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getRetainedBytes() {
    return this.retainedBytes
  }

  private notify() {
    for (const listener of this.listeners) listener()
  }
}

export function createBrowserAttachmentService() {
  return new BrowserAttachmentService()
}

