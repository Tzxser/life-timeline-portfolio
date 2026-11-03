import { listen } from '@tauri-apps/api/event'
import { invokeDesktop } from '@/lib/desktop-commands'

export interface UpdaterStatus {
  currentVersion: string
  automaticCheck: boolean
  ignoredVersion: string | null
  lastCheckedAt: string | null
  busy: 'checking' | 'downloading' | 'installing' | null
}

export interface AvailableUpdate {
  token: string
  version: string
  notes: string
  publishedAt: string | null
}

export interface UpdateCheckResult {
  status: 'available' | 'upToDate' | 'ignored' | 'disabled' | 'offline' | 'busy' | 'throttled'
  currentVersion: string
  update: AvailableUpdate | null
  checkedAt: string | null
  ignoredVersion: string | null
}

export interface UpdateDownload {
  downloadToken: string
  version: string
}

export interface UpdateProgress {
  phase: 'downloading' | 'verifying' | 'ready' | 'backingUp' | 'installing'
  version: string
  downloadedBytes: number
  totalBytes: number | null
}

export interface UpdaterGateway {
  status(): Promise<UpdaterStatus>
  preferences(automaticCheck: boolean): Promise<UpdaterStatus>
  check(manual: boolean): Promise<UpdateCheckResult>
  ignore(version: string): Promise<UpdaterStatus>
  download(token: string): Promise<UpdateDownload>
  install(downloadToken: string): Promise<unknown>
  listenProgress(callback: (progress: UpdateProgress) => void): Promise<() => void>
}

export const desktopUpdaterGateway: UpdaterGateway = {
  status: () => invokeDesktop('updater_status'),
  preferences: (automaticCheck) => invokeDesktop('updater_preferences', { request: { automaticCheck } }),
  check: (manual) => invokeDesktop('updater_check', { request: { manual } }),
  ignore: (version) => invokeDesktop('updater_ignore', { request: { version } }),
  download: (token) => invokeDesktop('updater_download', { request: { token } }),
  install: (downloadToken) => invokeDesktop('updater_install', { request: { downloadToken, frontendFlushed: true } }),
  listenProgress: (callback) => listen<UpdateProgress>('life-timeline://update-progress', ({ payload }) => callback(payload)),
}

/** Android has an independent APK updater. Native Android code owns the
 * package, versionCode and signing-certificate checks before opening the
 * system installer; the renderer only receives opaque tokens. */
export const androidUpdaterGateway: UpdaterGateway = {
  status: () => invokeDesktop('android_updater_status'),
  preferences: (automaticCheck) => invokeDesktop('android_updater_preferences', { request: { automaticCheck } }),
  check: (manual) => invokeDesktop('android_updater_check', { request: { manual } }),
  ignore: (version) => invokeDesktop('android_updater_ignore', { request: { version } }),
  download: (token) => invokeDesktop('android_updater_download', { request: { token } }),
  install: (downloadToken) => invokeDesktop('android_updater_install', { request: { downloadToken, frontendFlushed: true } }),
  listenProgress: (callback) => listen<UpdateProgress>('life-timeline://update-progress', ({ payload }) => callback(payload)),
}

export type UpdaterPhase = 'idle' | 'checking' | 'saving' | 'downloading' | 'verifying' | 'finalizing' | 'installing'

export interface AppUpdaterState {
  status: UpdaterStatus | null
  phase: UpdaterPhase
  update: AvailableUpdate | null
  promptOpen: boolean
  manualPrompt: boolean
  progress: UpdateProgress | null
  error: string | null
  notice: string | null
  savingPreferences: boolean
}

export const EMPTY_UPDATER_STATE: AppUpdaterState = {
  status: null, phase: 'idle', update: null, promptOpen: false,
  manualPrompt: false, progress: null, error: null, notice: null, savingPreferences: false,
}

export const AUTOMATIC_UPDATE_INTERVAL = 6 * 60 * 60 * 1000
const OFFLINE_RETRY_INTERVAL = 60 * 1000
/** Keep a renderer-side bound even if a native bridge or transport stalls. */
export const UPDATE_CHECK_TIMEOUT_MS = 15_000

function failureText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

export function isInstallingUpdate(phase: UpdaterPhase): boolean {
  return phase === 'finalizing' || phase === 'installing'
}

/**
 * The renderer never handles an installer URL, path or signature. Native code
 * owns the checked manifest and only issues a download token after verification.
 * Keeping this controller independent of React makes all save/error transitions
 * testable without invoking an installer or contacting a release server.
 */
export class AppUpdaterController {
  private state: AppUpdaterState = EMPTY_UPDATER_STATE
  private listeners = new Set<() => void>()
  private laterVersions = new Set<string>()
  private lastAutomaticAttempt: number | null = null
  private automaticDelay = AUTOMATIC_UPDATE_INTERVAL
  private runningCheck: Promise<void> | null = null
  private runningUpdate = false
  private disposed = false
  private unlisten: (() => void) | null = null
  private gateway: UpdaterGateway
  private flush: () => Promise<void>
  private lockForInstall: (locked: boolean) => void
  private now: () => number
  private checkTimeoutMs: number

  constructor(options: {
    gateway?: UpdaterGateway
    flush: () => Promise<void>
    lockForInstall: (locked: boolean) => void
    now?: () => number
    checkTimeoutMs?: number
  }) {
    this.gateway = options.gateway ?? desktopUpdaterGateway
    this.flush = options.flush
    this.lockForInstall = options.lockForInstall
    this.now = options.now ?? Date.now
    this.checkTimeoutMs = options.checkTimeoutMs ?? UPDATE_CHECK_TIMEOUT_MS
  }

  getSnapshot = (): AppUpdaterState => this.state
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private patch(patch: Partial<AppUpdaterState>): void {
    if (this.disposed) return
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }

  async initialize(): Promise<void> {
    try {
      const status = await this.gateway.status()
      if (this.disposed) return
      // lastCheckedAt includes failed/offline attempts. Native preferences
      // know whether to apply a 1-minute retry or a 6-hour success interval;
      // let native make the first decision after a restart.
      this.patch({ status, error: null })
      // Progress is optional. Download completion still comes from the checked
      // IPC result if the event bridge is unavailable.
      try {
        const unlisten = await this.gateway.listenProgress((progress) => this.acceptProgress(progress))
        if (this.disposed) unlisten()
        else this.unlisten = unlisten
      } catch { /* Retain indeterminate download progress. */ }
    } catch (error) {
      this.patch({ error: failureText(error, '暂时无法读取更新设置，请稍后重试。') })
    }
  }

  private acceptProgress(progress: UpdateProgress): void {
    if (!this.runningUpdate || !progress || progress.version !== this.state.update?.version) return
    if (!['downloading', 'verifying', 'ready', 'backingUp', 'installing'].includes(progress.phase)) return
    if (!Number.isFinite(progress.downloadedBytes) || progress.downloadedBytes < 0) return
    const phase = progress.phase === 'verifying' && !isInstallingUpdate(this.state.phase) ? 'verifying' : this.state.phase
    // A "ready" event is informational, never permission to install.
    this.patch({ progress, phase })
  }

  check(manual = false): Promise<void> {
    if (this.disposed || this.runningUpdate) return Promise.resolve()
    if (this.runningCheck) return this.runningCheck
    if (!manual && (!this.state.status?.automaticCheck || this.state.savingPreferences)) return Promise.resolve()
    if (!manual && this.lastAutomaticAttempt !== null && this.now() - this.lastAutomaticAttempt < this.automaticDelay) return Promise.resolve()
    this.lastAutomaticAttempt = this.now()
    this.automaticDelay = AUTOMATIC_UPDATE_INTERVAL
    this.patch({ phase: 'checking', ...(manual ? { error: null, notice: '正在检查新版本…' } : {}) })
    this.runningCheck = this.performCheck(manual).finally(() => { this.runningCheck = null })
    return this.runningCheck
  }

  private async performCheck(manual: boolean): Promise<void> {
    try {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('检查更新超时，网络可能暂时不可达；已停止等待，请稍后重试。')), this.checkTimeoutMs)
        })
        const result = await Promise.race([this.gateway.check(manual), timeout])
        if (this.disposed) return
        await this.applyCheckResult(result, manual)
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    } catch (error) {
      this.automaticDelay = OFFLINE_RETRY_INTERVAL
      if (manual) this.patch({ error: failureText(error, '检查更新未完成，请稍后重试。'), notice: null })
    } finally {
      this.patch({ phase: 'idle' })
    }
  }

  private async applyCheckResult(result: UpdateCheckResult, manual: boolean): Promise<void> {
      if (this.disposed) return
      const status = this.state.status ? {
        ...this.state.status, currentVersion: result.currentVersion,
        ignoredVersion: result.ignoredVersion, lastCheckedAt: result.checkedAt ?? this.state.status.lastCheckedAt,
      } : null
      this.patch({ status })
      if (result.status === 'throttled' || result.status === 'busy') {
        // A throttled result after restart may represent a recent OFFLINE
        // attempt. Only native knows that persisted distinction. Ask again
        // after a minute; native still enforces the real network interval.
        this.automaticDelay = OFFLINE_RETRY_INTERVAL
      }
      if (result.status === 'available' && result.update) {
        const ignored = result.ignoredVersion === result.update.version || this.laterVersions.has(result.update.version)
        // A preference may have changed while the request was in flight.
        if (manual || (this.state.status?.automaticCheck && !ignored)) {
          this.patch({ update: result.update, promptOpen: true, manualPrompt: manual, error: null, notice: null })
        }
      } else if (result.status === 'offline') {
        this.automaticDelay = OFFLINE_RETRY_INTERVAL
        if (manual) this.patch({ notice: null, error: '暂时无法连接更新服务。你可以继续离线使用，稍后再检查。' })
      } else if (manual) {
        const notice = result.status === 'upToDate' ? '当前已是最新版本。'
          : result.status === 'busy' ? '另一项更新操作正在进行，请稍后再试。'
            : result.status === 'ignored' ? '已忽略这个版本，请稍后再检查。'
              : result.status === 'disabled' ? '自动检查已关闭，你仍可以手动检查。'
                : '刚刚检查过更新，请稍后再试。'
        this.patch({ notice, error: null })
      }
  }

  async setAutomaticCheck(automaticCheck: boolean): Promise<void> {
    if (this.disposed || this.state.savingPreferences) return
    this.patch({ savingPreferences: true, error: null })
    try {
      const status = await this.gateway.preferences(automaticCheck)
      this.patch({ status, ...(!automaticCheck && !this.state.manualPrompt && !this.runningUpdate ? { promptOpen: false } : {}) })
    } catch (error) {
      this.patch({ error: failureText(error, '更新设置未能保存，请重试。') })
    } finally { this.patch({ savingPreferences: false }) }
  }

  later(): void {
    if (this.runningUpdate) {
      if (this.state.phase === 'downloading' || this.state.phase === 'verifying') this.patch({ promptOpen: false })
      return
    }
    if (this.state.update) this.laterVersions.add(this.state.update.version)
    this.patch({ promptOpen: false, error: null })
  }

  showProgress(): void {
    if (this.state.update) this.patch({ promptOpen: true, manualPrompt: true })
  }

  async ignore(): Promise<void> {
    if (!this.state.update || this.runningUpdate || this.state.savingPreferences) return
    this.patch({ savingPreferences: true, error: null })
    const version = this.state.update.version
    try {
      const status = await this.gateway.ignore(version)
      this.laterVersions.add(version)
      this.patch({ status, promptOpen: false, notice: `已忽略 ${version}，下一个新版本仍会提醒。` })
    } catch (error) {
      this.patch({ error: failureText(error, '未能保存忽略设置，请重试。') })
    } finally { this.patch({ savingPreferences: false }) }
  }

  /** Invoked only by the explicit download-and-update button. */
  async downloadAndInstall(): Promise<void> {
    const update = this.state.update
    if (!update || this.runningUpdate || this.runningCheck || this.state.savingPreferences || this.disposed) return
    this.runningUpdate = true
    this.patch({ phase: 'saving', progress: null, error: null, promptOpen: true, manualPrompt: true })
    try {
      // Uses the same IME, import/export, preference and revision queue barrier
      // as the application's native close protection.
      await this.flush()
      if (this.disposed) return
      this.patch({ phase: 'downloading' })
      const downloaded = await this.gateway.download(update.token)
      if (this.disposed) return
      if (!downloaded.downloadToken || downloaded.version !== update.version) {
        throw new Error('下载结果与所选版本不一致，已取消安装。请重新检查更新。')
      }
      // The host synchronously opens a native modal before flushing again.
      // This prevents new input while preserving edits made during download.
      this.patch({ phase: 'finalizing', promptOpen: true })
      this.lockForInstall(true)
      await this.flush()
      if (this.disposed) return
      this.patch({ phase: 'installing' })
      await this.gateway.install(downloaded.downloadToken)
      // Android returns to the app after the user confirms the system
      // installer. Clear the prompt immediately so an old token cannot be
      // submitted a second time; desktop installers may close the app, but
      // the same state is safe if the window remains open.
      this.patch({ notice: '更新安装程序已启动。', promptOpen: false, update: null })
    } catch (error) {
      this.patch({ error: failureText(error, '更新没有完成，软件和日记已保留，请重试。'), promptOpen: true })
    } finally {
      this.lockForInstall(false)
      this.runningUpdate = false
      this.patch({ phase: 'idle' })
    }
  }

  dispose(): void {
    this.disposed = true
    this.unlisten?.()
    this.unlisten = null
    this.listeners.clear()
    this.lockForInstall(false)
  }
}
