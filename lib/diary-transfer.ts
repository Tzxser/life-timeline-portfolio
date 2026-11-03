import { open, save } from '@tauri-apps/plugin-dialog'
import { invokeDesktop } from '@/lib/desktop-commands'

export type DiaryConflictAction = 'merge' | 'replace' | 'skip'

export interface DiaryExportRequest {
  destinationPath: string
  startDate?: string | null
  endDate?: string | null
  overwrite?: boolean
}

export interface DiaryExportResult {
  archivePath: string
  diaryCount: number
  attachmentCount: number
  byteSize: number
  sha256: string
  exportedAt: string
  startDate: string | null
  endDate: string | null
}

export interface DiaryConflictSide {
  id: string
  title: string
  characterCount: number
  attachmentCount: number
}

export interface DiaryConflict {
  date: string
  local: DiaryConflictSide
  incoming: DiaryConflictSide
  identical: boolean
}

export interface DiaryScanResult {
  scheduleConflicts?: Array<{ id: string; name: string; kind: 'source' | 'card'; local: Record<string, unknown>; incoming: Record<string, unknown> }>
  scanToken: string
  archivePath: string
  archiveSha256: string
  diaryCount: number
  attachmentCount: number
  newCount: number
  conflicts: DiaryConflict[]
  diaries: Array<{ id: string; date: string; title: string; attachmentCount: number }>
  startDate: string | null
  endDate: string | null
  canImport: boolean
  warnings: string[]
}

export interface DiaryImportRequest {
  scheduleDecisions?: Array<{ id: string; side: 'local' | 'incoming' }>
  archivePath: string
  scanToken: string
  decisions: Array<{ date: string; action: DiaryConflictAction }>
}

export interface DiaryImportResult {
  added: number
  merged: number
  replaced: number
  skipped: number
  attachmentCount: number
  previousLibraryBackupPath: string | null
  revision: number
}

// Callers drain editor saves BEFORE starting an archive operation. A close
// request waits for in-flight native work without making an import wait for
// its own pre-save barrier.
const pendingTransfers = new Set<Promise<unknown>>()

async function transfer<T>(command: string, request: object): Promise<T> {
  const work = invokeDesktop<T>(command, { request })
  pendingTransfers.add(work)
  try {
    return await work
  } finally {
    pendingTransfers.delete(work)
  }
}

export async function waitForDiaryTransfers(): Promise<void> {
  while (pendingTransfers.size > 0) {
    await Promise.allSettled([...pendingTransfers])
  }
}

function pathForOperation(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new TypeError('请选择有效的日记 ZIP 文件路径。')
  }
  return value
}

export function isDiaryDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  if (year < 1 || month < 1 || month > 12 || day < 1) return false
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
}

export function exportDiaries(request: DiaryExportRequest): Promise<DiaryExportResult> {
  const destinationPath = pathForOperation(request.destinationPath)
  const startDate = request.startDate ?? null
  const endDate = request.endDate ?? null
  if ((startDate === null) !== (endDate === null)) throw new TypeError('请同时选择开始日期和结束日期。')
  if (startDate !== null && endDate !== null && (!isDiaryDate(startDate) || !isDiaryDate(endDate) || startDate > endDate)) {
    throw new TypeError('请选择有效的日期区间，开始日期不能晚于结束日期。')
  }
  return transfer('diary_export', { ...request, destinationPath, startDate, endDate })
}

export function scanDiaries(request: { archivePath: string }): Promise<DiaryScanResult> {
  return transfer('diary_scan', { archivePath: pathForOperation(request.archivePath) })
}

export function importDiaries(request: DiaryImportRequest): Promise<DiaryImportResult> {
  const archivePath = pathForOperation(request.archivePath)
  if (!request.scanToken?.trim()) throw new TypeError('请先扫描日记包并检查冲突。')
  const dates = new Set<string>()
  for (const decision of request.decisions) {
    if (!isDiaryDate(decision.date) || !['merge', 'replace', 'skip'].includes(decision.action) || dates.has(decision.date)) {
      throw new TypeError('日期冲突的处理选项无效，请重新选择。')
    }
    dates.add(decision.date)
  }
  return transfer('diary_import', { archivePath, scanToken: request.scanToken, decisions: request.decisions, ...(request.scheduleDecisions?.length ? { scheduleDecisions: request.scheduleDecisions } : {}) })
}

export async function chooseDiaryExportPath(): Promise<string | null> {
  return save({ title: '导出日记 ZIP', defaultPath: 'life-timeline-diaries.zip', filters: [{ name: 'life-timeline 日记包', extensions: ['zip'] }] })
}

export async function chooseDiaryImportPath(): Promise<string | null> {
  const selected = await open({ title: '导入日记 ZIP', multiple: false, directory: false, filters: [{ name: 'life-timeline 日记包', extensions: ['zip'] }] })
  return typeof selected === 'string' ? selected : null
}
