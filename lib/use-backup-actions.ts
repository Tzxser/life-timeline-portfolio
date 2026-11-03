'use client'

import { useCallback, useRef, useState } from 'react'
import {
  exportBackup,
  flushDesktop,
  restoreBackup,
  scanBackup,
  type BackupExportResult,
  type BackupRestoreResult,
  type BackupScanResult,
} from '@/lib/desktop-commands'
import { useLifeStore } from '@/lib/life-store'

export interface BackupActionState {
  busy: 'scan' | 'export' | 'restore' | null
  error: string | null
  scan: BackupScanResult | null
  lastExport: BackupExportResult | null
  lastRestore: BackupRestoreResult | null
}

export interface RestoreFromScanRequest {
  archivePath: string
  scan: BackupScanResult
}

/**
 * Small UI adapter for settings/help surfaces. It does not open native file
 * dialogs itself; the caller chooses a path with the Tauri dialog plugin and
 * passes that one-shot path here. Restore is accepted only for the exact scan
 * token/path the user just reviewed, so a stale preview cannot replace data.
 */
export function useBackupActions() {
  const { flushPersistence } = useLifeStore()
  const [state, setState] = useState<BackupActionState>({
    busy: null,
    error: null,
    scan: null,
    lastExport: null,
    lastRestore: null,
  })
  const operation = useRef(0)

  const begin = useCallback((kind: BackupActionState['busy']) => {
    operation.current += 1
    const id = operation.current
    setState((previous) => ({ ...previous, busy: kind, error: null }))
    return id
  }, [])

  const finishIfCurrent = useCallback((id: number, patch: Partial<BackupActionState>) => {
    if (operation.current !== id) return
    setState((previous) => ({ ...previous, ...patch, busy: null }))
  }, [])

  const scan = useCallback(
    async (archivePath: string): Promise<BackupScanResult> => {
      const id = begin('scan')
      try {
        const result = await scanBackup({ archivePath })
        finishIfCurrent(id, { scan: result })
        return result
      } catch (error) {
        finishIfCurrent(id, { error: error instanceof Error ? error.message : '扫描备份失败' })
        throw error
      }
    },
    [begin, finishIfCurrent],
  )

  const exportArchive = useCallback(
    async (destinationPath: string, overwrite = false): Promise<BackupExportResult> => {
      const id = begin('export')
      try {
        // Drain the renderer queue first.  The native checkpoint only knows
        // about SQLite; calling it alone could archive a revision still held
        // in the React/Tiptap debounce queue.
        await flushPersistence()
        await flushDesktop({ reason: 'backup' })
        const result = await exportBackup({ destinationPath, overwrite })
        finishIfCurrent(id, { lastExport: result })
        return result
      } catch (error) {
        finishIfCurrent(id, { error: error instanceof Error ? error.message : '导出备份失败' })
        throw error
      }
    },
    [begin, finishIfCurrent, flushPersistence],
  )

  const restore = useCallback(
    async ({ archivePath, scan }: RestoreFromScanRequest): Promise<BackupRestoreResult> => {
      const id = begin('restore')
      try {
        if (!scan.canRestore || scan.archivePath !== archivePath) {
          throw new Error('备份扫描结果已失效，请重新扫描后再恢复')
        }
        await flushPersistence()
        await flushDesktop({ reason: 'restore' })
        const result = await restoreBackup({
          archivePath,
          scanToken: scan.scanToken,
          confirmation: 'replace-current',
        })
        finishIfCurrent(id, { lastRestore: result, scan: null })
        return result
      } catch (error) {
        finishIfCurrent(id, { error: error instanceof Error ? error.message : '恢复备份失败' })
        throw error
      }
    },
    [begin, finishIfCurrent, flushPersistence],
  )

  const clearError = useCallback(() => {
    setState((previous) => ({ ...previous, error: null }))
  }, [])

  return { state, scan, exportArchive, restore, clearError }
}
