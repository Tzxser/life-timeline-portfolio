'use client'

import { useEffect, useState } from 'react'
import { FolderOpen, HardDriveDownload, RotateCcw } from 'lucide-react'
import { isDesktopRuntime } from '@/lib/platform'
import { isAndroidRuntime } from '@/lib/platform/runtime'
import { openDataDirectory } from '@/lib/desktop-commands'
import type { BackupScanResult } from '@/lib/desktop-commands'
import { useLifeStore } from '@/lib/life-store'
import { useBackupStatus } from '@/lib/backup-status'
import { chooseBackupArchive, chooseBackupDestination } from '@/lib/native-dialog'
import { useBackupActions } from '@/lib/use-backup-actions'

const sectionTitle = 'font-serif text-sm text-foreground'

/** Local-first data controls kept separate from visual timeline settings. */
export function LocalDataSection() {
  const [desktop, setDesktop] = useState(false)
  const [android, setAndroid] = useState(false)
  const [dataPath, setDataPath] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { state, exportArchive, scan, restore } = useBackupActions()
  const { persistenceStatus, persistenceError, flushPersistence } = useLifeStore()
  const backupStatus = useBackupStatus()
  const [retryingSave, setRetryingSave] = useState(false)
  const [pendingScan, setPendingScan] = useState<BackupScanResult | null>(null)

  useEffect(() => { setDesktop(isDesktopRuntime()); setAndroid(isAndroidRuntime()) }, [])

  if (!desktop) {
    return (
      <section className="flex flex-col gap-2" aria-label="本地数据">
        <h3 className={sectionTitle}>本地数据</h3>
        <p className="text-xs leading-relaxed text-muted-foreground/70">
          静态预览不会读写本机资料库。桌面版启动后，这里会提供数据目录、备份和恢复。
        </p>
      </section>
    )
  }

  const busy = state.busy !== null
  const persistenceLabel = persistenceStatus === 'loading'
    ? '正在打开资料库'
    : persistenceStatus === 'saving'
      ? '正在保存'
      : persistenceStatus === 'saved'
        ? '已保存'
        : persistenceStatus === 'error'
          ? '保存失败'
          : '已准备好'
  const showError = (value: unknown, fallback: string) => {
    setMessage(null)
    setError(value instanceof Error ? value.message : fallback)
  }
  const handleRetrySave = async () => {
    setRetryingSave(true)
    try {
      await flushPersistence()
      setMessage('本地保存已重试并完成。')
      setError(null)
    } catch (cause) {
      showError(cause, '本地保存重试失败，未丢弃当前编辑。')
    } finally {
      setRetryingSave(false)
    }
  }
  const handleOpenDataDirectory = async () => {
    try {
      setError(null)
      const result = await openDataDirectory()
      setDataPath(result.path)
      setMessage('已打开本机数据目录。')
    } catch (cause) {
      showError(cause, '无法打开本机数据目录。')
    }
  }

  const handleExport = async () => {
    try {
      setError(null)
      const destination = await chooseBackupDestination()
      if (!destination) return
      const result = await exportArchive(destination)
      setMessage(`备份已写入，SHA-256：${result.sha256.slice(0, 16)}…`)
    } catch (cause) {
      showError(cause, '导出备份失败，当前数据未被替换。')
    }
  }

  const handleRestore = async () => {
    try {
      setError(null)
      const archivePath = await chooseBackupArchive()
      if (!archivePath) return
      const scanResult = await scan(archivePath)
      if (!scanResult.canRestore) throw new Error('备份预检未通过，未执行恢复。')
      // Keep the scan result in the page instead of using window.confirm.
      // Tauri's WebView does not consistently surface browser confirm dialogs
      // after a native file picker closes, leaving the restore flow apparently
      // stuck. The explicit preview also makes the replacement semantics
      // visible before the native restore command is invoked.
      setPendingScan(scanResult)
      setMessage('备份预检完成，请确认是否替换当前资料库。')
    } catch (cause) {
      showError(cause, '恢复备份失败，当前数据应保持不变。')
    }
  }

  const handleConfirmRestore = async () => {
    if (!pendingScan) return
    const scanResult = pendingScan
    try {
      setError(null)
      // Android's document provider URI is copied into private staging by
      // the scan. Restore must use exactly the file bound to the scan token.
      const result = await restore({ archivePath: scanResult.archivePath, scan: scanResult })
      setPendingScan(null)
      setMessage(`恢复完成，已自动备份原资料库：${result.previousLibraryBackupPath}`)
      window.location.reload()
    } catch (cause) {
      showError(cause, '恢复备份失败，当前数据应保持不变。')
    }
  }

  const handleCancelRestore = () => {
    setPendingScan(null)
    setMessage('已取消恢复，当前数据未改变。')
    setError(null)
  }

  return (
    <section className="flex flex-col gap-3" aria-label="本地数据">
      <div>
        <h3 className={sectionTitle}>本地数据</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground/70">
          {android ? '日记和附件保存在此手机的应用内。请定期导出到手机文件夹或其他设备；卸载应用会清除应用内数据。' : '数据保存在本机应用目录。导出前会等待保存完成；恢复会先扫描并备份当前资料库。'}
        </p>
      </div>
      <div className="flex flex-col gap-1 rounded-md border border-border/70 px-3 py-2 text-xs" aria-label="本地保存状态">
        <p className="text-foreground" role="status">本地保存：{persistenceLabel}</p>
        {persistenceStatus === 'error' && persistenceError && (
          <p className="break-all text-destructive" role="alert">{persistenceError}</p>
        )}
        {persistenceStatus === 'error' && (
          <button
            type="button"
            disabled={retryingSave || busy}
            onClick={() => void handleRetrySave()}
            className="mt-1 inline-flex w-fit rounded border border-border px-2 py-1 text-xs text-foreground hover:bg-muted disabled:cursor-wait disabled:opacity-50"
          >
            {retryingSave ? '正在重试…' : '重试保存'}
          </button>
        )}
      </div>
      <div className="flex flex-col gap-1 rounded-md border border-border/70 px-3 py-2 text-xs" aria-label="自动备份状态">
        <p className="text-foreground" role="status">
          自动备份：{backupStatus?.status === 'running' ? '进行中' : backupStatus?.status === 'success' ? '最近检查成功' : backupStatus?.status === 'error' ? '失败' : '读取中'}
        </p>
        {backupStatus?.lastSuccessAt && <p className="text-muted-foreground/70">最近成功：{backupStatus.lastSuccessAt}</p>}
        {backupStatus?.status === 'error' && <p className="break-all text-destructive" role="alert">{backupStatus.error ?? '本次自动备份未完成。'}</p>}
      </div>
      <div className="grid grid-cols-1 gap-2">
        {!android && <button type="button" disabled={busy} onClick={() => void handleOpenDataDirectory()} className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-muted disabled:cursor-wait disabled:opacity-50">
          <FolderOpen className="size-4" /> 打开数据目录
        </button>}
        <button type="button" disabled={busy} onClick={() => void handleExport()} className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-muted disabled:cursor-wait disabled:opacity-50">
          <HardDriveDownload className="size-4" /> 导出备份
        </button>
        <button type="button" disabled={busy || pendingScan !== null} onClick={() => void handleRestore()} className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-muted disabled:cursor-wait disabled:opacity-50">
          <RotateCcw className="size-4" /> 从备份恢复
        </button>
      </div>
      {pendingScan && (
        <div className="flex flex-col gap-2 rounded-md border border-amber-500/50 bg-amber-500/5 px-3 py-3 text-xs" role="dialog" aria-label="确认恢复备份">
          <p className="font-medium text-foreground">已完成备份预检</p>
          <p className="leading-relaxed text-muted-foreground">
            确认后将替换当前本机资料库，程序会先自动备份当前数据。请确认下面的内容是否为要恢复的版本。
          </p>
          <dl className="grid grid-cols-3 gap-2 text-center" aria-label="备份内容统计">
            <div className="rounded border border-border/70 px-2 py-1"><dt className="text-muted-foreground">日记</dt><dd className="font-medium text-foreground">{pendingScan.counts.events}</dd></div>
            <div className="rounded border border-border/70 px-2 py-1"><dt className="text-muted-foreground">阶段</dt><dd className="font-medium text-foreground">{pendingScan.counts.stages}</dd></div>
            <div className="rounded border border-border/70 px-2 py-1"><dt className="text-muted-foreground">附件</dt><dd className="font-medium text-foreground">{pendingScan.counts.attachments}</dd></div>
          </dl>
          <div className="flex flex-wrap gap-2 pt-1">
            <button type="button" disabled={busy} onClick={handleCancelRestore} className="rounded border border-border px-3 py-1.5 text-foreground hover:bg-muted disabled:cursor-wait disabled:opacity-50">
              取消恢复
            </button>
            <button type="button" disabled={busy} onClick={() => void handleConfirmRestore()} className="rounded bg-foreground px-3 py-1.5 text-background hover:opacity-90 disabled:cursor-wait disabled:opacity-50">
              {busy && state.busy === 'restore' ? '正在恢复…' : '确认恢复'}
            </button>
          </div>
        </div>
      )}
      {state.busy && <p className="text-xs text-muted-foreground" role="status">正在{state.busy === 'scan' ? '扫描备份' : state.busy === 'export' ? '导出备份' : '恢复资料库'}…</p>}
      {dataPath && <p className="break-all text-[11px] text-muted-foreground/70">数据目录：{dataPath}</p>}
      {message && <p className="break-all text-xs text-foreground" role="status">{message}</p>}
      {error && <p className="break-all text-xs text-destructive" role="alert">{error}</p>}
    </section>
  )
}
