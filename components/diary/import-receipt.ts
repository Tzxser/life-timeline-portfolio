import type { DiaryImportResult } from '@/lib/diary-transfer'

export interface DiaryImportReceipt {
  added: number
  merged: number
  replaced: number
  skipped: number
  attachmentCount: number
  backupCreated: boolean
  aiImport?: boolean
  aiRolledBack?: boolean
  warnings?: string[]
}

const RECEIPT_KEY = 'life-timeline:diary-import-receipt'

/** A one-use receipt contains counts only, never diary text, file paths, or media. */
export function storeDiaryImportReceipt(result: DiaryImportResult & { warnings?: string[] }, aiImport = false): void {
  const receipt: DiaryImportReceipt = {
    added: result.added,
    merged: result.merged,
    replaced: result.replaced,
    skipped: result.skipped,
    attachmentCount: result.attachmentCount,
    backupCreated: Boolean(result.previousLibraryBackupPath),
    aiImport,
    warnings: result.warnings ?? [],
  }
  try { window.sessionStorage.setItem(RECEIPT_KEY, JSON.stringify(receipt)) } catch { /* Reload must still happen if storage is unavailable. */ }
}

export function storeAiRollbackReceipt(): void {
  const receipt: DiaryImportReceipt = { added: 0, merged: 0, replaced: 0, skipped: 0, attachmentCount: 0, backupCreated: true, aiRolledBack: true }
  try { window.sessionStorage.setItem(RECEIPT_KEY, JSON.stringify(receipt)) } catch { /* Reload still refreshes the library. */ }
}

export function consumeDiaryImportReceipt(): DiaryImportReceipt | null {
  try {
    const value = window.sessionStorage.getItem(RECEIPT_KEY)
    window.sessionStorage.removeItem(RECEIPT_KEY)
    if (!value) return null
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object') return null
    const receipt = parsed as DiaryImportReceipt
    if (![receipt.added, receipt.merged, receipt.replaced, receipt.skipped, receipt.attachmentCount].every((count) => Number.isSafeInteger(count) && count >= 0)) return null
    if (typeof receipt.backupCreated !== 'boolean') return null
    if (receipt.aiImport !== undefined && typeof receipt.aiImport !== 'boolean') return null
    if (receipt.aiRolledBack !== undefined && typeof receipt.aiRolledBack !== 'boolean') return null
    if (receipt.warnings !== undefined && (!Array.isArray(receipt.warnings) || !receipt.warnings.every((warning) => typeof warning === 'string'))) return null
    return receipt
  } catch { return null }
}
