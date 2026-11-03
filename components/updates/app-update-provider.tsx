'use client'

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { ArrowDownToLine, RefreshCw, X } from 'lucide-react'
import { androidUpdaterGateway, AppUpdaterController, desktopUpdaterGateway, EMPTY_UPDATER_STATE, isInstallingUpdate, type AppUpdaterState } from '@/lib/app-updater'
import { useLifeStore } from '@/lib/life-store'
import { registerOverlay, useAnyOverlayOpen } from '@/lib/overlay-registry'
import { isAndroidRuntime } from '@/lib/platform/runtime'

interface UpdateContextValue { controller: AppUpdaterController | null; state: AppUpdaterState }
const UpdateContext = createContext<UpdateContextValue>({ controller: null, state: EMPTY_UPDATER_STATE })
const emptySubscribe = () => () => undefined
const emptySnapshot = () => EMPTY_UPDATER_STATE
const primary = 'rounded-md bg-primary px-4 py-2.5 text-sm text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40'
const quiet = 'rounded-md border border-border px-4 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40'

export function useAppUpdater(): UpdateContextValue { return useContext(UpdateContext) }

export function AppUpdateProvider({ children }: { children: ReactNode }) {
  const { platformKind, flushPersistence } = useLifeStore()
  const [controller, setController] = useState<AppUpdaterController | null>(null)
  const [installLocked, setInstallLocked] = useState(false)
  const [promptVisible, setPromptVisible] = useState(false)
  const overlayOpen = useAnyOverlayOpen()
  const state = useSyncExternalStore(controller?.subscribe ?? emptySubscribe, controller?.getSnapshot ?? emptySnapshot, emptySnapshot)
  const lockForInstall = useCallback((locked: boolean) => {
    // showModal in the lock's layout effect makes every other page/dialog
    // inert before the controller starts its final save barrier.
    if (locked) flushSync(() => setInstallLocked(true))
    else setInstallLocked(false)
  }, [])

  useEffect(() => {
    const android = isAndroidRuntime()
    if (platformKind !== 'desktop' && !android) return
    const next = new AppUpdaterController({ gateway: android ? androidUpdaterGateway : desktopUpdaterGateway, flush: flushPersistence, lockForInstall })
    setController(next)
    let active = true
    let idleId: number | null = null
    let startupTimer: ReturnType<typeof setTimeout> | null = null
    const check = () => {
      if (active && navigator.onLine !== false) void next.check()
    }
    void next.initialize().then(() => {
      if (!active) return
      // Initialization and the seasonal opening never wait for the network.
      startupTimer = setTimeout(() => {
        if ('requestIdleCallback' in window) idleId = window.requestIdleCallback(check, { timeout: 10_000 })
        else check()
      }, android ? 5_000 : 15_000)
    })
    window.addEventListener('online', check)
    // Also retry when "online" arrived inside a short offline throttle.
    // Successful checks still stop at the controller's six-hour gate.
    const interval = setInterval(check, 60 * 1000)
    return () => {
      active = false
      if (startupTimer) clearTimeout(startupTimer)
      if (idleId !== null) window.cancelIdleCallback(idleId)
      clearInterval(interval)
      window.removeEventListener('online', check)
      next.dispose()
    }
  }, [platformKind, flushPersistence, lockForInstall])

  useEffect(() => {
    if (!state.promptOpen) { setPromptVisible(false); return }
    if (promptVisible || state.manualPrompt) { setPromptVisible(true); return }
    const maybeShow = () => {
      const editing = document.activeElement?.closest('input, textarea, [contenteditable="true"]')
      if (!overlayOpen && !editing && document.visibilityState === 'visible') setPromptVisible(true)
    }
    maybeShow()
    const timer = setInterval(maybeShow, 5_000)
    return () => clearInterval(timer)
  }, [state.promptOpen, state.manualPrompt, promptVisible, overlayOpen])

  const downloading = state.phase === 'downloading' || state.phase === 'verifying'
  return (
    <UpdateContext.Provider value={{ controller, state }}>
      {children}
      {controller && state.update && promptVisible && state.promptOpen && !installLocked && (
        <UpdatePrompt controller={controller} state={state} android={isAndroidRuntime()} />
      )}
      {controller && downloading && !state.promptOpen && (
        <button type="button" onClick={() => controller.showProgress()} className="fixed right-5 bottom-5 z-40 flex items-center gap-2 rounded-lg border border-border bg-background px-4 py-3 text-xs text-muted-foreground shadow-sm hover:text-foreground" aria-label="查看更新下载进度">
          <ArrowDownToLine className="size-4" />
          <span>更新正在{state.phase === 'verifying' ? '校验' : '下载'}{progressPercent(state) !== null ? ` · ${progressPercent(state)}%` : '…'}</span>
        </button>
      )}
      {installLocked && <InstallLock android={isAndroidRuntime()} />}
    </UpdateContext.Provider>
  )
}

function useModalLifecycle(ref: React.RefObject<HTMLDialogElement | null>) {
  useLayoutEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    const previousFocus = document.activeElement as HTMLElement | null
    dialog.showModal()
    dialog.focus({ preventScroll: true })
    const release = registerOverlay()
    return () => {
      dialog.close()
      release()
      if (previousFocus?.isConnected) previousFocus.focus?.({ preventScroll: true })
    }
  }, [ref])
}

function progressPercent(state: AppUpdaterState): number | null {
  const total = state.progress?.totalBytes
  if (!total || !Number.isFinite(total) || total <= 0) return null
  return Math.max(0, Math.min(100, Math.round((state.progress?.downloadedBytes ?? 0) * 100 / total)))
}

function UpdatePrompt({ controller, state, android }: { controller: AppUpdaterController; state: AppUpdaterState; android: boolean }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  useModalLifecycle(dialogRef)
  const update = state.update!
  const busy = state.phase !== 'idle' && state.phase !== 'checking'
  const downloading = state.phase === 'downloading' || state.phase === 'verifying'
  const percent = progressPercent(state)
  const close = () => { if (!busy || downloading) controller.later() }
  const phaseText = state.phase === 'saving' ? '正在保存当前编辑…'
    : state.phase === 'verifying' ? '正在校验下载的更新…'
      : state.phase === 'downloading' ? '正在下载新版本…'
        : isInstallingUpdate(state.phase) ? '正在保存日记并准备安装…' : null
  return createPortal(
    <dialog ref={dialogRef} tabIndex={-1} aria-labelledby="lt-update-title" aria-describedby="lt-update-description" aria-modal="true" className="animate-modal-in fixed inset-0 m-auto max-h-[85dvh] w-[min(32rem,calc(100vw-2rem))] overflow-y-auto rounded-xl border border-border bg-background p-0 text-foreground shadow-xl backdrop:bg-foreground/20" onCancel={(event) => { event.preventDefault(); close() }} onClick={(event) => { if (event.target === event.currentTarget) { const box = event.currentTarget.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close() } }}>
      <header className="flex items-start justify-between gap-4 border-b border-border/70 px-6 py-5">
        <div className="flex items-center gap-3">
          <span aria-hidden="true" className="flex size-10 items-center justify-center rounded-full border border-border text-primary"><ArrowDownToLine className="size-4" strokeWidth={1.4} /></span>
          <div><h2 id="lt-update-title" className="font-serif text-xl">有新的 life-timeline</h2><p className="mt-1 font-mono text-xs text-muted-foreground">{state.status?.currentVersion ?? '当前版本'} → {update.version}</p></div>
        </div>
        <button type="button" aria-label="稍后更新" title="稍后" disabled={busy && !downloading} onClick={close} className="rounded-md p-1 text-muted-foreground hover:bg-muted disabled:opacity-30"><X className="size-4" /></button>
      </header>
      <div className="space-y-4 px-6 py-5">
        <p id="lt-update-description" className="text-sm leading-relaxed text-muted-foreground">{android ? '更新会保留你的日记和附件。首次更新时，如需授权，会打开系统设置；允许 life-timeline 安装未知应用并返回后，将继续打开系统安装界面，由你确认覆盖安装。' : '更新会保留你的日记和附件。下载时可以继续使用，完成后将保存当前编辑、备份资料库并打开更新安装程序。'}</p>
        <section aria-label="更新说明" className="max-h-52 overflow-y-auto rounded-lg border border-border/70 bg-muted/20 px-4 py-3">
          <h3 className="mb-2 text-xs text-muted-foreground">这次更新</h3>
          <p className="whitespace-pre-wrap text-sm leading-7">{update.notes.trim() || '包含体验改进与问题修复。'}</p>
        </section>
        {phaseText && <div role="status" aria-live="polite" className="space-y-2 text-sm text-muted-foreground"><p>{phaseText}{state.phase === 'downloading' && percent !== null ? ` ${percent}%` : ''}</p>{downloading && <progress aria-label="更新下载进度" max={100} value={percent ?? undefined} className="h-1.5 w-full accent-primary" />}</div>}
        {state.error && <p role="alert" className="text-sm leading-relaxed text-destructive">{state.error}</p>}
        {busy && downloading && <p className="text-xs leading-relaxed text-muted-foreground/75">选择「后台下载」可继续记录，安装前会再次保存。</p>}
      </div>
      <footer className="flex flex-wrap justify-end gap-2 border-t border-border/70 px-6 py-4">
        {busy ? <button type="button" disabled={!downloading} className={quiet} onClick={() => controller.later()}>{downloading ? '后台下载' : '请稍候…'}</button> : <>
          <button type="button" className={quiet} disabled={state.savingPreferences} onClick={() => void controller.ignore()}>忽略此版本</button>
          <button type="button" className={quiet} disabled={state.savingPreferences} onClick={() => controller.later()}>稍后</button>
          <button type="button" className={primary} disabled={state.savingPreferences || state.phase === 'checking'} onClick={() => void controller.downloadAndInstall()}>{state.error ? '重试更新' : android ? '下载并安装' : '下载并更新'}</button>
        </>}
      </footer>
    </dialog>, document.body,
  )
}

function InstallLock({ android }: { android: boolean }) {
  const ref = useRef<HTMLDialogElement>(null)
  useModalLifecycle(ref)
  return createPortal(
    <dialog ref={ref} tabIndex={-1} aria-label="正在安全更新" aria-modal="true" aria-busy="true" className="fixed inset-0 m-auto w-[min(26rem,calc(100vw-2rem))] rounded-xl border border-border bg-background p-8 text-foreground shadow-xl backdrop:bg-foreground/25" onCancel={(event) => event.preventDefault()}>
      <div className="flex items-center gap-3"><RefreshCw aria-hidden="true" className="size-5 animate-spin text-primary motion-reduce:animate-none" /><h2 className="font-serif text-lg">正在安全更新</h2></div>
      <p role="status" className="mt-4 text-sm leading-7 text-muted-foreground">{android ? '正在保存编辑并准备系统安装界面。如已打开安装授权设置，请允许 life-timeline 安装未知应用并返回；取消授权后可以稍后重试。' : '正在保存编辑、等待文件操作完成，并为日记建立备份。完成后将打开安装程序，请稍候。'}</p>
    </dialog>, document.body,
  )
}
