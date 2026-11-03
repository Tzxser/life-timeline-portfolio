/**
 * Typed boundary for the Tauri 2 commands used by the UI.
 *
 * Tauri's module is SSR-safe, while calls remain guarded by the native
 * bridge. Keeping critical commands in the initial bundle avoids waiting
 * on a separate JavaScript chunk when opening a picker or saving data.
 */

import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import type { BackupManifest } from '@/lib/backup-contract'

export const DESKTOP_COMMANDS = {
  openDataDir: 'open_data_dir',
  backupExport: 'backup_export',
  backupScan: 'backup_scan',
  backupRestore: 'backup_restore',
  backupFlush: 'backup_flush',
  backupStatus: 'backup_status',
} as const

export interface DataDirectoryResult {
  path: string
}

export interface DesktopCommandErrorPayload {
  code?: string
  message?: string
  diagnostics?: unknown
}

export interface BackupFlushRequest {
  reason?: 'backup' | 'restore' | 'close' | 'manual'
}

export interface BackupFlushResult {
  revision: number
  flushedAt: string
}

export type BackupStatusKind = 'running' | 'success' | 'error'

/** Native automatic-backup state. This is independent from editor saves. */
export interface BackupStatusResult {
  status: BackupStatusKind
  checkedAt: string
  lastSuccessAt?: string | null
  error?: string | null
}

export interface BackupExportRequest {
  /** A path selected for this operation by the native save dialog. */
  destinationPath: string
  overwrite?: boolean
}

export interface BackupExportResult {
  archivePath: string
  archiveFormatVersion: number
  schemaVersion: number
  entries: number
  byteSize: number
  sha256: string
  exportedAt: string
}

export interface BackupScanRequest {
  /** A path selected for this operation by the native open dialog. */
  archivePath: string
}

export interface BackupScanCounts {
  events: number
  stages: number
  attachments: number
}

export interface BackupScanResult {
  scanToken: string
  archivePath: string
  manifest: BackupManifest
  counts: BackupScanCounts
  archiveByteSize: number
  archiveSha256: string
  diagnostics: Array<{ code: string; message: string; path?: string }>
  canRestore: boolean
}

export interface BackupRestoreRequest {
  archivePath: string
  /** Token returned by backup_scan; prevents restoring a different file. */
  scanToken: string
  /** Explicit UI confirmation required by the replacement semantics. */
  confirmation: 'replace-current'
}

export interface BackupRestoreResult {
  restoredAt: string
  /** A complete backup of the previous library made before switching. */
  previousLibraryBackupPath: string
  revision: number
  counts: BackupScanCounts
}

export class DesktopBridgeUnavailableError extends Error {
  constructor() {
    super('当前页面没有连接到 life-timeline 桌面服务')
    this.name = 'DesktopBridgeUnavailableError'
  }
}

export class DesktopCommandError extends Error {
  readonly command: string
  readonly payload: DesktopCommandErrorPayload | unknown

  constructor(command: string, payload: DesktopCommandErrorPayload | unknown) {
    const message =
      payload && typeof payload === 'object' && 'message' in payload && typeof payload.message === 'string'
        ? payload.message
        : `桌面命令 ${command} 执行失败`
    super(message)
    this.name = 'DesktopCommandError'
    this.command = command
    this.payload = payload
  }
}

export type DesktopInvoker = <T>(command: string, args?: Record<string, unknown>) => Promise<T>

let configuredInvoker: DesktopInvoker | null = null

/** Configure the native `invoke` function from the Tauri entrypoint/tests. */
export function configureDesktopInvoker(invoker: DesktopInvoker | null): void {
  configuredInvoker = invoker
}

interface TauriInternals {
  invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown>
}

function globalInvoker(): DesktopInvoker | null {
  if (typeof window === 'undefined') return null
  const internals = (window as Window & { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__
  if (!internals || typeof internals.invoke !== 'function') return null
  return async <T>(command: string, args?: Record<string, unknown>) =>
    (await internals.invoke!(command, args)) as T
}

async function resolveInvoker(): Promise<DesktopInvoker> {
  const global = configuredInvoker ?? globalInvoker()
  if (global) return global
  if (typeof window !== 'undefined' && (window as Window & { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__) {
    return async <T>(command: string, args?: Record<string, unknown>) =>
      (await tauriInvoke(command, args)) as T
  }
  throw new DesktopBridgeUnavailableError()
}

function assertTransientPath(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\u0000')) {
    throw new TypeError(`${label}必须是非空路径`)
  }
  return value
}

function normalizeBackupStatus(value: unknown): BackupStatusResult {
  if (!value || typeof value !== 'object') {
    throw new DesktopCommandError(DESKTOP_COMMANDS.backupStatus, value)
  }
  const candidate = value as Record<string, unknown>
  const status = candidate.status
  const checkedAt = candidate.checkedAt
  if (
    (status !== 'running' && status !== 'success' && status !== 'error') ||
    typeof checkedAt !== 'string' ||
    checkedAt.trim() === ''
  ) {
    throw new DesktopCommandError(DESKTOP_COMMANDS.backupStatus, {
      code: 'backup.status_invalid',
      message: '自动备份状态返回格式无效',
      diagnostics: value,
    })
  }
  return {
    status,
    checkedAt,
    lastSuccessAt: typeof candidate.lastSuccessAt === 'string' ? candidate.lastSuccessAt : null,
    error: typeof candidate.error === 'string' ? candidate.error : null,
  }
}

export async function invokeDesktop<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    const invoker = await resolveInvoker()
    return await invoker<T>(command, args)
  } catch (error) {
    if (error instanceof DesktopBridgeUnavailableError || error instanceof DesktopCommandError) throw error
    throw new DesktopCommandError(command, error)
  }
}

/** Flush all queued writes before taking a backup or switching libraries. */
export function flushDesktop(request: BackupFlushRequest = { reason: 'manual' }): Promise<BackupFlushResult> {
  // `backup_flush` currently has no request struct on the Rust side.  Keep the
  // reason local to the renderer and invoke it without arguments so Tauri's
  // generated command resolver remains exact.
  void request
  return invokeDesktop<BackupFlushResult>(DESKTOP_COMMANDS.backupFlush)
}

export async function getBackupStatus(): Promise<BackupStatusResult> {
  const raw = await invokeDesktop<unknown>(DESKTOP_COMMANDS.backupStatus)
  return normalizeBackupStatus(raw)
}

export function openDataDirectory(): Promise<DataDirectoryResult> {
  return invokeDesktop<DataDirectoryResult>(DESKTOP_COMMANDS.openDataDir)
}

export function exportBackup(request: BackupExportRequest): Promise<BackupExportResult> {
  const destinationPath = assertTransientPath(request.destinationPath, '导出路径')
  return invokeDesktop<BackupExportResult>(DESKTOP_COMMANDS.backupExport, {
    request: {
      ...request,
      destinationPath,
    },
  })
}

export function scanBackup(request: BackupScanRequest): Promise<BackupScanResult> {
  const archivePath = assertTransientPath(request.archivePath, '备份路径')
  return invokeDesktop<BackupScanResult>(DESKTOP_COMMANDS.backupScan, { request: { archivePath } })
}

export function restoreBackup(request: BackupRestoreRequest): Promise<BackupRestoreResult> {
  const archivePath = assertTransientPath(request.archivePath, '备份路径')
  if (!request.scanToken || request.scanToken.trim() === '') {
    throw new TypeError('恢复前必须先完成备份扫描')
  }
  if (request.confirmation !== 'replace-current') {
    throw new TypeError('恢复资料库必须明确确认替换当前资料库')
  }
  return invokeDesktop<BackupRestoreResult>(DESKTOP_COMMANDS.backupRestore, {
    request: {
      ...request,
      archivePath,
    },
  })
}

