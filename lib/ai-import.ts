import { open } from '@tauri-apps/plugin-dialog'
import { invokeDesktop } from '@/lib/desktop-commands'
import type { DiaryConflictAction, DiaryImportResult, DiaryScanResult } from '@/lib/diary-transfer'

export interface ApiProfile {
  id: string
  name: string
  baseUrl: string
  model: string
  hasKey: boolean
  verifiedAt: string | null
  supportsImages: boolean
}

export interface ApiStatus {
  profiles: ApiProfile[]
  activeProfileId: string | null
  usable: boolean
}

export interface ApiSaveRequest {
  id?: string | null
  name: string
  baseUrl: string
  model: string
  /** Sent to Rust once; never returned, persisted in browser storage or logged. */
  apiKey?: string | null
}

export interface AiSourceSummary {
  sessionId: string
  sourceLabel: string
  documentCount: number
  blockCount: number
  attachmentCount: number
  imageCount: number
  textCharacterCount: number
  requiresVision: boolean
  warnings: string[]
  samples: Array<{ id: string; sourceName: string; textPreview: string; thumbnailDataUrl?: string | null }>
}

export type AiInspectResult = { kind: 'native'; archivePath: string } | { kind: 'external'; source: AiSourceSummary }

export interface AiDraftEntry {
  id: string
  date: string | null
  title: string
  sourceNames: string[]
  textPreview: string
  transcribedText: string
  canEditTranscription: boolean
  attachmentCount: number
}

export interface AiPreview {
  sessionId: string
  entries: AiDraftEntry[]
  warnings: string[]
  profileName: string
  model: string
}

export interface AiEntryEdit {
  id: string
  date: string
  title: string
  transcribedText: string
}

export interface AiUndoInfo {
  id: string
  createdAt: string
  added: number
  merged: number
  replaced: number
  canRollback: boolean
  reason: string | null
}

export interface AiImportStatus { latestUndo: AiUndoInfo | null }
export interface AiCommitResult extends DiaryImportResult { undoId: string | null; warnings?: string[] }
export interface AiRollbackResult { restored: boolean; safetyBackupPath: string; revision: number }

const pendingWork = new Set<Promise<unknown>>()
const mustFinishBeforeClose = new Set(['api_save', 'api_remove', 'ai_import_commit', 'ai_import_rollback'])

async function call<T>(command: string, request?: object): Promise<T> {
  const pending = invokeDesktop<T>(command, request ? { request } : undefined)
  if (mustFinishBeforeClose.has(command)) pendingWork.add(pending)
  try { return await pending } finally { pendingWork.delete(pending) }
}

/** Close protects actual mutations; a slow, read-only AI analysis never traps the window. */
export async function waitForAiImports(): Promise<void> {
  while (pendingWork.size) await Promise.allSettled([...pendingWork])
}

export const getApiStatus = () => call<ApiStatus>('api_status')
export const saveApiProfile = (request: ApiSaveRequest) => call<ApiStatus>('api_save', request)
export const applyApiProfile = (profileId: string) => call<ApiStatus>('api_apply', { profileId })
export const removeApiProfile = (profileId: string) => call<ApiStatus>('api_remove', { profileId })
export const getAiImportStatus = () => call<AiImportStatus>('ai_import_status')
export const inspectAiSources = (paths: string[]) => call<AiInspectResult>('ai_import_inspect', { paths })
export const analyzeAiSources = (sessionId: string, expectedProfile: ApiProfile) => call<AiPreview>('ai_import_analyze', { sessionId, expectedProfile })
export const buildAiArchive = (sessionId: string, entries: AiEntryEdit[]) => call<DiaryScanResult>('ai_import_build', { sessionId, entries })
export const commitAiImport = (sessionId: string, scanToken: string, decisions: Array<{ date: string; action: DiaryConflictAction }>) =>
  call<AiCommitResult>('ai_import_commit', { sessionId, scanToken, decisions })
export const discardAiImport = (sessionId: string) => call<void>('ai_import_discard', { sessionId })
export const rollbackAiImport = (undoId: string) => call<AiRollbackResult>('ai_import_rollback', { undoId })

export async function chooseExternalSources(): Promise<string[] | null> {
  const result = await open({
    title: '选择日记、文档或照片', multiple: true, directory: false,
    filters: [{ name: '日记与图片', extensions: ['zip', 'md', 'markdown', 'txt', 'html', 'htm', 'json', 'jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif', 'tif', 'tiff'] },
      { name: '所有文件', extensions: ['*'] }],
  })
  return Array.isArray(result) ? result : typeof result === 'string' ? [result] : null
}
