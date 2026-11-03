/**
 * Versioned backup contract shared by the web UI and the Tauri commands.
 *
 * The ZIP itself is parsed and written by Rust.  This module deliberately
 * contains no filesystem or ZIP implementation: it validates the untrusted
 * names and metadata that cross the UI/native boundary, and provides the
 * same shape checks to browser-side preview code and tests.
 */

import type { LifeEvent } from '@/types/life-event'
import type { LifeStage } from '@/types/life-stage'

export const BACKUP_ARCHIVE_FORMAT_VERSION = 1 as const
export const BACKUP_SCHEMA_VERSION = 1 as const

/** Root files emitted by the native exporter.  The SQLite snapshot is
 * optional: life.json remains the portable, lossless interchange document,
 * while a single online-backup snapshot can be retained for faster recovery.
 */
export const BACKUP_ROOT_FILES = new Set(['manifest.json', 'life.json', 'database.sqlite3'])

/**
 * These limits protect the scanner before Rust extracts an archive. They are
 * intentionally generous enough for a lifetime of photos while still
 * rejecting the common ZIP-bomb and path-confusion cases.
 */
export const BACKUP_SECURITY_LIMITS = {
  maxEntries: 10_000,
  maxPathLength: 1_024,
  maxPathDepth: 32,
  maxSegmentLength: 255,
  maxArchiveBytes: 8 * 1024 * 1024 * 1024,
  maxEntryBytes: 512 * 1024 * 1024,
  maxCompressionRatio: 200,
  maxManifestBytes: 4 * 1024 * 1024,
  maxLifeJsonBytes: 128 * 1024 * 1024,
  maxJsonDepth: 64,
  maxJsonNodes: 250_000,
} as const

export type BackupDiagnosticCode =
  | 'invalid_archive'
  | 'unsupported_archive_format'
  | 'unsupported_schema'
  | 'missing_required_entry'
  | 'unsafe_path'
  | 'absolute_path'
  | 'parent_path'
  | 'device_name'
  | 'path_conflict'
  | 'symlink_entry'
  | 'reparse_point'
  | 'directory_entry'
  | 'invalid_size'
  | 'entry_too_large'
  | 'archive_too_large'
  | 'compression_bomb'
  | 'invalid_manifest'
  | 'invalid_hash'
  | 'invalid_document'
  | 'json_too_deep'
  | 'json_too_large'
  | 'duplicate_id'
  | 'missing_attachment'
  | 'unexpected_entry'

export interface BackupDiagnostic {
  code: BackupDiagnosticCode
  message: string
  /** Archive-relative path or logical id involved in the error. */
  path?: string
}

export interface ArchiveEntryDescriptor {
  /** Name exactly as read from the ZIP central directory. */
  path: string
  compressedSize: number
  uncompressedSize: number
  isDirectory?: boolean
  isSymlink?: boolean
  isReparsePoint?: boolean
  /** Unix mode, when supplied by the ZIP reader. */
  mode?: number
}

export interface BackupManifestFile {
  path: string
  sha256: string
  byteSize: number
  compressedSize?: number
}

export interface BackupManifest {
  archiveFormatVersion: typeof BACKUP_ARCHIVE_FORMAT_VERSION
  appVersion: string
  schemaVersion: number
  exportedAt: string
  files: BackupManifestFile[]
  /** Optional counts make a scan preview cheap without parsing life.json. */
  counts?: {
    events?: number
    stages?: number
    attachments?: number
  }
}

export interface BackupAttachmentRecord {
  id: string
  name: string
  mimeType: string
  byteSize: number
  kind: 'image' | 'file'
  width?: number
  height?: number
  lastModified?: number
  /** Archive-relative path, never an absolute user path. */
  path: string
  sha256?: string
}

export interface BackupDocument {
  schemaVersion: number
  exportedAt?: string
  stages: LifeStage[]
  events: LifeEvent[]
  attachments: BackupAttachmentRecord[]
  /** Display settings/preferences are versioned but intentionally open ended. */
  preferences?: Record<string, unknown>
}

export interface ArchiveValidationResult<T = unknown> {
  ok: boolean
  value?: T
  diagnostics: BackupDiagnostic[]
}

export interface BackupArchiveInput {
  entries: ArchiveEntryDescriptor[]
  manifest: unknown
  /** Parsed life.json. Rust may omit this during a cheap metadata-only scan. */
  document?: unknown
}

export interface ValidatedArchive {
  manifest: BackupManifest
  document?: BackupDocument
  entries: ArchiveEntryDescriptor[]
}

const SHA256_RE = /^[a-f0-9]{64}$/i
const CONTROL_RE = /[\u0000-\u001f\u007f]/
const DRIVE_RE = /^[a-zA-Z]:/u
const RESERVED_DEVICE_RE = /^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\..*)?$/iu

function diagnostic(
  code: BackupDiagnosticCode,
  message: string,
  path?: string,
): BackupDiagnostic {
  return path === undefined ? { code, message } : { code, message, path }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function ownString(value: Record<string, unknown>, key: string): string | undefined {
  const result = value[key]
  return typeof result === 'string' ? result : undefined
}

function ownSafeInteger(value: Record<string, unknown>, key: string): number | undefined {
  const result = value[key]
  return typeof result === 'number' && Number.isSafeInteger(result) && result >= 0 ? result : undefined
}

/**
 * Normalize one ZIP entry name without ever resolving it against a host path.
 * Backslashes are rejected instead of converted: accepting both separators
 * makes it too easy for a later Windows API to re-introduce traversal.
 */
export function normalizeArchivePath(raw: unknown): ArchiveValidationResult<string> {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, diagnostics: [diagnostic('unsafe_path', '归档条目路径不能为空')] }
  }
  if (raw.length > BACKUP_SECURITY_LIMITS.maxPathLength) {
    return {
      ok: false,
      diagnostics: [diagnostic('unsafe_path', `归档条目路径超过 ${BACKUP_SECURITY_LIMITS.maxPathLength} 个字符`, raw)],
    }
  }
  if (CONTROL_RE.test(raw)) {
    return { ok: false, diagnostics: [diagnostic('unsafe_path', '归档条目路径包含控制字符', raw)] }
  }
  if (raw.includes('\\')) {
    return { ok: false, diagnostics: [diagnostic('unsafe_path', '归档条目不得包含反斜杠', raw)] }
  }
  if (raw.startsWith('/') || raw.startsWith('//') || DRIVE_RE.test(raw)) {
    return { ok: false, diagnostics: [diagnostic('absolute_path', '归档条目不得是绝对路径或 UNC 路径', raw)] }
  }
  if (raw.includes(':')) {
    return { ok: false, diagnostics: [diagnostic('absolute_path', '归档条目不得包含 Windows 盘符或 ADS 冒号', raw)] }
  }

  const parts = raw.split('/')
  if (parts.length > BACKUP_SECURITY_LIMITS.maxPathDepth) {
    return {
      ok: false,
      diagnostics: [diagnostic('unsafe_path', `归档条目目录层级超过 ${BACKUP_SECURITY_LIMITS.maxPathDepth} 层`, raw)],
    }
  }
  if (parts.some((part) => part.length === 0)) {
    return { ok: false, diagnostics: [diagnostic('unsafe_path', '归档条目包含空路径段', raw)] }
  }
  for (const part of parts) {
    if (part === '..') {
      return { ok: false, diagnostics: [diagnostic('parent_path', '归档条目不得包含 .. 路径段', raw)] }
    }
    if (part === '.') {
      return { ok: false, diagnostics: [diagnostic('unsafe_path', '归档条目不得包含 . 路径段', raw)] }
    }
    if (part.length > BACKUP_SECURITY_LIMITS.maxSegmentLength) {
      return {
        ok: false,
        diagnostics: [diagnostic('unsafe_path', `归档条目路径段超过 ${BACKUP_SECURITY_LIMITS.maxSegmentLength} 个字符`, raw)],
      }
    }
    // Windows trims trailing dots/spaces before opening a file. Rejecting
    // them prevents two archive names from targeting the same destination.
    if (part !== part.trimEnd().replace(/[. ]+$/u, '')) {
      return { ok: false, diagnostics: [diagnostic('unsafe_path', '归档条目路径段不得以点或空格结尾', raw)] }
    }
    if (RESERVED_DEVICE_RE.test(part.replace(/[. ]+$/u, ''))) {
      return { ok: false, diagnostics: [diagnostic('device_name', '归档条目不得使用 Windows 设备名', raw)] }
    }
  }

  // ZIP names are case-sensitive, while the Windows destination is normally
  // case-insensitive. Keep the original spelling but reject equivalent names
  // in validateArchiveEntries below.
  return { ok: true, value: raw, diagnostics: [] }
}

function isSymlinkMode(mode: number | undefined): boolean {
  return typeof mode === 'number' && (mode & 0xf000) === 0xa000
}

/** Validate central-directory metadata before extraction. */
export function validateArchiveEntries(
  entries: ArchiveEntryDescriptor[],
  limits: typeof BACKUP_SECURITY_LIMITS = BACKUP_SECURITY_LIMITS,
): ArchiveValidationResult<ArchiveEntryDescriptor[]> {
  const diagnostics: BackupDiagnostic[] = []
  if (!Array.isArray(entries)) {
    return { ok: false, diagnostics: [diagnostic('invalid_archive', '归档条目清单不是数组')] }
  }
  if (entries.length === 0) {
    diagnostics.push(diagnostic('invalid_archive', '归档没有任何条目'))
  }
  if (entries.length > limits.maxEntries) {
    diagnostics.push(diagnostic('archive_too_large', `归档条目超过 ${limits.maxEntries} 个`))
  }

  let totalUncompressed = 0
  const seen = new Map<string, string>()
  const normalized: ArchiveEntryDescriptor[] = []
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.path !== 'string') {
      diagnostics.push(diagnostic('invalid_archive', '归档包含格式错误的条目'))
      continue
    }
    const pathResult = normalizeArchivePath(entry.path)
    if (!pathResult.ok || !pathResult.value) {
      diagnostics.push(...pathResult.diagnostics)
      continue
    }
    const path = pathResult.value
    const key = path.toLocaleLowerCase('en-US')
    const prior = seen.get(key)
    if (prior) {
      diagnostics.push(diagnostic('path_conflict', `归档路径与 ${prior} 大小写冲突`, path))
    } else {
      seen.set(key, path)
    }

    if (entry.isDirectory || path.endsWith('/')) {
      diagnostics.push(diagnostic('directory_entry', '备份归档不得包含目录条目', path))
    }
    if (entry.isSymlink || entry.isReparsePoint || isSymlinkMode(entry.mode)) {
      diagnostics.push(diagnostic('symlink_entry', '备份归档不得包含符号链接或 reparse point', path))
    }

    const compressed = entry.compressedSize
    const uncompressed = entry.uncompressedSize
    if (
      typeof compressed !== 'number' ||
      !Number.isSafeInteger(compressed) ||
      compressed < 0 ||
      typeof uncompressed !== 'number' ||
      !Number.isSafeInteger(uncompressed) ||
      uncompressed < 0
    ) {
      diagnostics.push(diagnostic('invalid_size', '归档条目大小不是非负安全整数', path))
      continue
    }
    if (uncompressed > limits.maxEntryBytes) {
      diagnostics.push(diagnostic('entry_too_large', `归档条目超过 ${limits.maxEntryBytes} 字节上限`, path))
    }
    totalUncompressed += uncompressed
    if (totalUncompressed > limits.maxArchiveBytes) {
      diagnostics.push(diagnostic('archive_too_large', `归档解压后超过 ${limits.maxArchiveBytes} 字节上限`, path))
    }
    if (uncompressed > 0 && compressed === 0) {
      diagnostics.push(diagnostic('compression_bomb', '归档条目压缩大小为 0 但声明有内容', path))
    } else if (compressed > 0 && uncompressed / compressed > limits.maxCompressionRatio) {
      diagnostics.push(
        diagnostic(
          'compression_bomb',
          `归档条目压缩膨胀比超过 ${limits.maxCompressionRatio}:1`,
          path,
        ),
      )
    }
    normalized.push({ ...entry, path })
  }

  return { ok: diagnostics.length === 0, value: normalized, diagnostics }
}

function validateArchiveRelativePath(raw: unknown, expectedPrefix?: string): BackupDiagnostic[] {
  const result = normalizeArchivePath(raw)
  if (!result.ok || !result.value) return result.diagnostics
  if (expectedPrefix && !result.value.startsWith(expectedPrefix)) {
    return [diagnostic('unsafe_path', `附件路径必须位于 ${expectedPrefix} 目录下`, result.value)]
  }
  return []
}

function isSupportedArchivePath(path: string): boolean {
  return BACKUP_ROOT_FILES.has(path) || path.startsWith('attachments/')
}

/** Validate the small manifest before any life.json data is trusted. */
export function validateBackupManifest(raw: unknown): ArchiveValidationResult<BackupManifest> {
  const diagnostics: BackupDiagnostic[] = []
  if (!isRecord(raw)) {
    return { ok: false, diagnostics: [diagnostic('invalid_manifest', 'manifest.json 必须是 JSON 对象')] }
  }
  if (raw.archiveFormatVersion !== BACKUP_ARCHIVE_FORMAT_VERSION) {
    diagnostics.push(
      diagnostic(
        'unsupported_archive_format',
        `不支持的归档格式版本: ${String(raw.archiveFormatVersion)}`,
      ),
    )
  }
  const appVersion = ownString(raw, 'appVersion')
  const exportedAt = ownString(raw, 'exportedAt')
  if (!appVersion) diagnostics.push(diagnostic('invalid_manifest', 'manifest 缺少 appVersion'))
  if (!exportedAt || Number.isNaN(Date.parse(exportedAt))) {
    diagnostics.push(diagnostic('invalid_manifest', 'manifest 的 exportedAt 不是有效时间'))
  }
  const schemaVersion = ownSafeInteger(raw, 'schemaVersion')
  if (schemaVersion === undefined || schemaVersion > BACKUP_SCHEMA_VERSION) {
    diagnostics.push(diagnostic('unsupported_schema', `不支持的资料库 schemaVersion: ${String(raw.schemaVersion)}`))
  }
  if (!Array.isArray(raw.files)) {
    diagnostics.push(diagnostic('invalid_manifest', 'manifest 缺少 files 数组'))
  }

  const files: BackupManifestFile[] = []
  const seen = new Set<string>()
  if (Array.isArray(raw.files)) {
    for (const item of raw.files) {
      if (!isRecord(item)) {
        diagnostics.push(diagnostic('invalid_manifest', 'manifest.files 含有非对象条目'))
        continue
      }
      const path = ownString(item, 'path')
      const pathDiagnostics = validateArchiveRelativePath(path)
      diagnostics.push(...pathDiagnostics)
      if (!path || pathDiagnostics.length > 0) continue
      if (!isSupportedArchivePath(path)) {
        diagnostics.push(diagnostic('unexpected_entry', 'manifest 含有不受支持的归档路径', path))
        continue
      }
      const key = path.toLocaleLowerCase('en-US')
      if (seen.has(key)) {
        diagnostics.push(diagnostic('path_conflict', 'manifest.files 含有重复路径', path))
        continue
      }
      seen.add(key)
      const sha256 = ownString(item, 'sha256')
      if (!sha256 || !SHA256_RE.test(sha256)) {
        diagnostics.push(diagnostic('invalid_hash', 'manifest 文件 hash 必须是 SHA-256 十六进制字符串', path))
        continue
      }
      const byteSize = ownSafeInteger(item, 'byteSize')
      if (byteSize === undefined || byteSize > BACKUP_SECURITY_LIMITS.maxEntryBytes) {
        diagnostics.push(diagnostic('invalid_size', 'manifest 文件 byteSize 无效或过大', path))
        continue
      }
      const compressedSize =
        item.compressedSize === undefined ? undefined : ownSafeInteger(item, 'compressedSize')
      if (item.compressedSize !== undefined && compressedSize === undefined) {
        diagnostics.push(diagnostic('invalid_size', 'manifest 文件 compressedSize 无效', path))
      }
      files.push({ path, sha256: sha256.toLowerCase(), byteSize, compressedSize })
    }
  }

  // manifest.json is intentionally not required in its own `files` list:
  // hashing the manifest bytes from inside itself would be circular.  The
  // outer archive validation still requires the manifest entry to exist.
  if (!seen.has('life.json')) diagnostics.push(diagnostic('missing_required_entry', '归档缺少 life.json'))

  if (diagnostics.length > 0 || !appVersion || !exportedAt || schemaVersion === undefined) {
    return { ok: false, diagnostics }
  }
  const counts = isRecord(raw.counts)
    ? {
        events: ownSafeInteger(raw.counts, 'events'),
        stages: ownSafeInteger(raw.counts, 'stages'),
        attachments: ownSafeInteger(raw.counts, 'attachments'),
      }
    : undefined
  return {
    ok: true,
    value: {
      archiveFormatVersion: BACKUP_ARCHIVE_FORMAT_VERSION,
      appVersion,
      schemaVersion,
      exportedAt,
      files,
      ...(counts ? { counts } : {}),
    },
    diagnostics: [],
  }
}

interface JsonShapeResult {
  diagnostics: BackupDiagnostic[]
}

/** Bound object depth/node count without recursively trusting hostile JSON. */
function inspectJsonShape(value: unknown, limits = BACKUP_SECURITY_LIMITS): JsonShapeResult {
  const diagnostics: BackupDiagnostic[] = []
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  let nodes = 0
  while (stack.length > 0) {
    const current = stack.pop()!
    nodes += 1
    if (nodes > limits.maxJsonNodes) {
      diagnostics.push(diagnostic('json_too_large', `JSON 节点超过 ${limits.maxJsonNodes} 个`))
      break
    }
    if (current.depth > limits.maxJsonDepth) {
      diagnostics.push(diagnostic('json_too_deep', `JSON 嵌套超过 ${limits.maxJsonDepth} 层`))
      break
    }
    if (!isRecord(current.value) && !Array.isArray(current.value)) continue
    const children = Array.isArray(current.value) ? current.value : Object.entries(current.value)
    for (const child of children) {
      const childValue = Array.isArray(current.value) ? child : child[1]
      if (!Array.isArray(current.value) && ['__proto__', 'prototype', 'constructor'].includes(child[0])) {
        diagnostics.push(diagnostic('invalid_document', 'JSON 含有禁止的原型污染键'))
        continue
      }
      stack.push({ value: childValue, depth: current.depth + 1 })
    }
  }
  return { diagnostics }
}

function ensureUniqueIds(
  values: unknown,
  label: string,
  diagnostics: BackupDiagnostic[],
): Set<string> {
  const ids = new Set<string>()
  if (!Array.isArray(values)) {
    diagnostics.push(diagnostic('invalid_document', `${label} 必须是数组`))
    return ids
  }
  for (const item of values) {
    if (!isRecord(item) || typeof item.id !== 'string' || item.id.trim() === '') {
      diagnostics.push(diagnostic('invalid_document', `${label} 含有无效 id`))
      continue
    }
    if (ids.has(item.id)) diagnostics.push(diagnostic('duplicate_id', `${label} 含有重复 id`, item.id))
    ids.add(item.id)
  }
  return ids
}

function collectDocumentAttachmentIds(event: LifeEvent): string[] {
  const ids = new Set<string>(
    Array.isArray(event.attachmentIds)
      ? event.attachmentIds.filter((id): id is string => typeof id === 'string')
      : [],
  )
  const doc = event.richContent?.doc
  if (!doc || typeof doc !== 'object') return [...ids]

  // Do not call the editor helper on untrusted JSON.  The helper assumes a
  // ProseMirror node tree and a hostile archive may contain null children or
  // primitive values.  Silently ignoring malformed nodes here still leaves
  // the structural `richContent` checks below to reject the document.
  const stack: unknown[] = [doc]
  while (stack.length > 0) {
    const value = stack.pop()
    if (!isRecord(value)) continue
    if (value.type === 'lifeImage' || value.type === 'lifeAttachment') {
      const attrs = value.attrs
      if (isRecord(attrs) && typeof attrs.attachmentId === 'string') ids.add(attrs.attachmentId)
    }
    if (Array.isArray(value.content)) stack.push(...value.content)
  }
  return [...ids]
}

/** Validate life.json records, IDs, references, and attachment paths. */
export function validateBackupDocument(raw: unknown): ArchiveValidationResult<BackupDocument> {
  const shape = inspectJsonShape(raw)
  const diagnostics = [...shape.diagnostics]
  if (!isRecord(raw)) {
    diagnostics.push(diagnostic('invalid_document', 'life.json 必须是 JSON 对象'))
    return { ok: false, diagnostics }
  }
  const schemaVersion = ownSafeInteger(raw, 'schemaVersion')
  if (schemaVersion === undefined || schemaVersion > BACKUP_SCHEMA_VERSION) {
    diagnostics.push(diagnostic('unsupported_schema', `不支持的 life.json schemaVersion: ${String(raw.schemaVersion)}`))
  }
  const stages = raw.stages
  const events = raw.events
  const attachments = raw.attachments
  const stageIds = ensureUniqueIds(stages, 'stages', diagnostics)
  ensureUniqueIds(events, 'events', diagnostics)
  const attachmentIds = ensureUniqueIds(attachments, 'attachments', diagnostics)
  if (stageIds.has('stage-all')) {
    diagnostics.push(diagnostic('invalid_document', '系统阶段 stage-all 不得写入备份'))
  }

  if (Array.isArray(events)) {
    for (const event of events) {
      if (!isRecord(event)) continue
      if (event.stageId !== null && event.stageId !== undefined && typeof event.stageId !== 'string') {
        diagnostics.push(diagnostic('invalid_document', '事件 stageId 无效', String(event.id)))
      }
      if (typeof event.stageId === 'string' && !stageIds.has(event.stageId)) {
        diagnostics.push(diagnostic('invalid_document', '事件引用了不存在的阶段', String(event.id)))
      }
      for (const id of collectDocumentAttachmentIds(event as unknown as LifeEvent)) {
        if (!attachmentIds.has(id)) diagnostics.push(diagnostic('missing_attachment', '正文引用了不存在的附件', id))
      }
      if (event.attachmentIds !== undefined && !Array.isArray(event.attachmentIds)) {
        diagnostics.push(diagnostic('invalid_document', '事件 attachmentIds 必须是数组', String(event.id)))
      }
      // Rich-content nodes are data, but hostile objects with a giant attrs
      // graph should still be covered by the global shape limits above.
      const richContent = event.richContent
      if (richContent !== undefined) {
        if (!isRecord(richContent) || richContent.version !== 1 || richContent.format !== 'tiptap-json') {
          diagnostics.push(diagnostic('invalid_document', '事件 richContent 版本或格式无效', String(event.id)))
        } else if (!isRecord(richContent.doc) || richContent.doc.type !== 'doc') {
          diagnostics.push(diagnostic('invalid_document', '事件 richContent.doc 无效', String(event.id)))
        }
      }
    }
  }
  if (Array.isArray(attachments)) {
    for (const attachment of attachments) {
      if (!isRecord(attachment)) continue
      diagnostics.push(...validateArchiveRelativePath(attachment.path, 'attachments/'))
      const size = ownSafeInteger(attachment, 'byteSize')
      if (size === undefined || size > BACKUP_SECURITY_LIMITS.maxEntryBytes) {
        diagnostics.push(diagnostic('invalid_size', '附件 byteSize 无效或过大', String(attachment.id)))
      }
      const hash = attachment.sha256
      if (hash !== undefined && (typeof hash !== 'string' || !SHA256_RE.test(hash))) {
        diagnostics.push(diagnostic('invalid_hash', '附件 sha256 无效', String(attachment.id)))
      }
    }
  }
  if (diagnostics.length > 0 || schemaVersion === undefined || !Array.isArray(stages) || !Array.isArray(events) || !Array.isArray(attachments)) {
    return { ok: false, diagnostics }
  }
  return {
    ok: true,
    value: {
      schemaVersion,
      exportedAt: ownString(raw, 'exportedAt'),
      stages: stages as LifeStage[],
      events: events as LifeEvent[],
      attachments: attachments as BackupAttachmentRecord[],
      preferences: isRecord(raw.preferences) ? raw.preferences : undefined,
    },
    diagnostics: [],
  }
}

/** Validate a scan result as a complete archive before restore is offered. */
export function validateBackupArchive(input: BackupArchiveInput): ArchiveValidationResult<ValidatedArchive> {
  const entryResult = validateArchiveEntries(input.entries)
  const diagnostics = [...entryResult.diagnostics]
  const manifestResult = validateBackupManifest(input.manifest)
  diagnostics.push(...manifestResult.diagnostics)

  const entryPaths = new Set((entryResult.value ?? []).map((entry) => entry.path.toLocaleLowerCase('en-US')))
  if (!entryPaths.has('manifest.json')) diagnostics.push(diagnostic('missing_required_entry', '归档缺少 manifest.json'))
  if (!entryPaths.has('life.json')) diagnostics.push(diagnostic('missing_required_entry', '归档缺少 life.json'))
  if (manifestResult.value) {
    for (const file of manifestResult.value.files) {
      if (!entryPaths.has(file.path.toLocaleLowerCase('en-US'))) {
        diagnostics.push(diagnostic('missing_required_entry', 'manifest 列出的文件不在归档中', file.path))
      }
    }
    for (const path of entryPaths) {
      if (!isSupportedArchivePath(path)) {
        diagnostics.push(diagnostic('unexpected_entry', '归档含有不受支持的顶层文件', path))
      }
    }
  }

  let document: BackupDocument | undefined
  if (input.document !== undefined) {
    const documentResult = validateBackupDocument(input.document)
    diagnostics.push(...documentResult.diagnostics)
    document = documentResult.value
  }
  if (document && manifestResult.value) {
    const counts = manifestResult.value.counts
    if (counts?.events !== undefined && counts.events !== document.events.length) {
      diagnostics.push(diagnostic('invalid_document', 'manifest events 数量与 life.json 不一致'))
    }
    if (counts?.stages !== undefined && counts.stages !== document.stages.length) {
      diagnostics.push(diagnostic('invalid_document', 'manifest stages 数量与 life.json 不一致'))
    }
    if (counts?.attachments !== undefined && counts.attachments !== document.attachments.length) {
      diagnostics.push(diagnostic('invalid_document', 'manifest attachments 数量与 life.json 不一致'))
    }
    const filesByPath = new Map(
      manifestResult.value!.files.map((file) => [file.path.toLocaleLowerCase('en-US'), file]),
    )
    for (const attachment of document.attachments) {
      const file = filesByPath.get(attachment.path.toLocaleLowerCase('en-US'))
      if (!file) {
        diagnostics.push(diagnostic('missing_required_entry', '附件元数据未对应归档文件', attachment.path))
        continue
      }
      if (file.byteSize !== attachment.byteSize) {
        diagnostics.push(diagnostic('invalid_size', '附件元数据与 manifest 字节数不一致', attachment.id))
      }
      if (attachment.sha256 && attachment.sha256.toLowerCase() !== file.sha256.toLowerCase()) {
        diagnostics.push(diagnostic('invalid_hash', '附件元数据与 manifest hash 不一致', attachment.id))
      }
    }
  }
  if (diagnostics.length > 0 || !manifestResult.value || !entryResult.value) {
    return { ok: false, diagnostics }
  }
  return {
    ok: true,
    value: { manifest: manifestResult.value, document, entries: entryResult.value },
    diagnostics: [],
  }
}

/** Error type used by UI previews and command wrappers when validation fails. */
export class BackupValidationError extends Error {
  readonly diagnostics: BackupDiagnostic[]

  constructor(message: string, diagnostics: BackupDiagnostic[]) {
    super(message)
    this.name = 'BackupValidationError'
    this.diagnostics = diagnostics
  }
}
