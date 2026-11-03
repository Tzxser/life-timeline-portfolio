import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DESKTOP_COMMANDS,
  configureDesktopInvoker,
  exportBackup,
  flushDesktop,
  getBackupStatus,
  restoreBackup,
  scanBackup,
} from '../lib/desktop-commands'

test('desktop command wrappers use the typed command names and pass selected paths verbatim', async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = []
  configureDesktopInvoker(async <T>(command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args })
    if (command === DESKTOP_COMMANDS.backupFlush) return { revision: 3, flushedAt: '2026-09-28T10:00:00Z' } as T
    if (command === DESKTOP_COMMANDS.backupExport) {
      return {
        archivePath: (args?.request as Record<string, unknown> | undefined)?.destinationPath,
        archiveFormatVersion: 1,
        schemaVersion: 1,
        entries: 2,
        byteSize: 10,
        sha256: 'a'.repeat(64),
        exportedAt: '2026-09-28T10:00:00Z',
      } as T
    }
    if (command === DESKTOP_COMMANDS.backupScan) {
      return { scanToken: 'scan-1', archivePath: (args?.request as Record<string, unknown> | undefined)?.archivePath, canRestore: true } as T
    }
    if (command === DESKTOP_COMMANDS.backupStatus) {
      return { status: 'success', checkedAt: '2026-09-28T10:00:00Z', lastSuccessAt: '2026-09-28T09:59:00Z', error: null } as T
    }
    return {
      restoredAt: '2026-09-28T10:00:00Z',
      previousLibraryBackupPath: 'backups/previous.zip',
      revision: 4,
      counts: { events: 0, stages: 0, attachments: 0 },
    } as T
  })

  const flushed = await flushDesktop({ reason: 'close' })
  const exported = await exportBackup({ destinationPath: 'C:/Users/test/backup.zip', overwrite: true })
  const scanned = await scanBackup({ archivePath: 'C:/Users/test/backup.zip' })
  const restored = await restoreBackup({
    archivePath: 'C:/Users/test/backup.zip',
    scanToken: 'scan-1',
    confirmation: 'replace-current',
  })
  const backupStatus = await getBackupStatus()

  assert.equal(flushed.revision, 3)
  assert.equal(exported.archivePath, 'C:/Users/test/backup.zip')
  assert.equal(scanned.scanToken, 'scan-1')
  assert.equal(restored.revision, 4)
  assert.equal(backupStatus.status, 'success')
  assert.equal(backupStatus.lastSuccessAt, '2026-09-28T09:59:00Z')
  assert.deepEqual(calls.map((call) => call.command), [
    DESKTOP_COMMANDS.backupFlush,
    DESKTOP_COMMANDS.backupExport,
    DESKTOP_COMMANDS.backupScan,
    DESKTOP_COMMANDS.backupRestore,
    DESKTOP_COMMANDS.backupStatus,
  ])
  assert.deepEqual(calls[0]?.args, undefined)
  assert.deepEqual(calls[1]?.args, { request: { destinationPath: 'C:/Users/test/backup.zip', overwrite: true } })
  assert.deepEqual(calls[2]?.args, { request: { archivePath: 'C:/Users/test/backup.zip' } })
  assert.deepEqual(calls[3]?.args, {
    request: {
      archivePath: 'C:/Users/test/backup.zip',
      scanToken: 'scan-1',
      confirmation: 'replace-current',
    },
  })

  configureDesktopInvoker(null)
})

test('backup command wrappers reject missing paths, NUL paths, and unconfirmed restores before IPC', () => {
  assert.throws(() => exportBackup({ destinationPath: '' }), /导出路径必须是非空路径/)
  assert.throws(() => scanBackup({ archivePath: 'bad\u0000path.zip' }), /备份路径必须是非空路径/)
  assert.throws(
    () => restoreBackup({ archivePath: 'backup.zip', scanToken: '', confirmation: 'replace-current' }),
    /恢复前必须先完成备份扫描/,
  )
  assert.throws(
    () => restoreBackup({ archivePath: 'backup.zip', scanToken: 'scan-1', confirmation: 'manual' as never }),
    /必须明确确认替换/,
  )
})

test('backup status wrapper validates independent native scheduler state', async () => {
  configureDesktopInvoker(async <T>() => ({ status: 'error', checkedAt: '2026-09-28T10:00:00Z', error: '磁盘空间不足' }) as T)
  const status = await getBackupStatus()
  assert.deepEqual(status, {
    status: 'error',
    checkedAt: '2026-09-28T10:00:00Z',
    lastSuccessAt: null,
    error: '磁盘空间不足',
  })
  configureDesktopInvoker(null)
})
