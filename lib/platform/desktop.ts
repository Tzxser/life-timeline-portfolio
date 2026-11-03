import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { isAndroidRuntime } from './runtime'
import { isPageUnloading, markPageUnloading } from '@/lib/page-lifecycle'
import type {
  LifePlatform,
  LoadSnapshotResult,
  SaveSnapshotAck,
  SaveSnapshotRequest,
  FlushResult,
} from './contracts'
import {
  PersistenceError,
  makeSnapshot,
  normalizeFlushResult,
  normalizeLoadResult,
  normalizeSaveAck,
} from './contracts'

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>

interface TauriWindow extends Window {
  __TAURI_INTERNALS__?: { invoke?: Invoke }
  __TAURI__?: { invoke?: Invoke }
}

function tauriWindow(): TauriWindow | null {
  return typeof window === 'undefined' ? null : window as TauriWindow
}

/** A conservative runtime check: browser previews must never call Tauri. */
export function isDesktopRuntime(): boolean {
  const current = tauriWindow()
  if (!current) return false
  if (current.__TAURI_INTERNALS__ || current.__TAURI__) return true
  const { protocol, hostname } = current.location
  if (protocol === 'tauri:' || protocol === 'asset:') return true
  if (hostname === 'tauri.localhost' || hostname.endsWith('.tauri.localhost')) return true
  return /\btauri\b/i.test(navigator.userAgent)
}

async function resolveInvoke(): Promise<Invoke> {
  const current = tauriWindow()
  const globalInvoke = current?.__TAURI_INTERNALS__?.invoke ?? current?.__TAURI__?.invoke
  if (globalInvoke) return globalInvoke.bind(current?.__TAURI_INTERNALS__ ?? current?.__TAURI__)

  // The Tauri modules are safe to evaluate during SSR: they access window
  // only when called. Keep critical IPC in the initial bundle so a stale or
  // unavailable lazy chunk cannot silently prevent saving or closing.
  if (current && isDesktopRuntime()) return tauriInvoke
  throw new PersistenceError('当前桌面窗口未提供受限本地通信。', 'TAURI_INVOKE_UNAVAILABLE')
}

async function invokeCommand(command: string, args?: Record<string, unknown>): Promise<unknown> {
  const invoke = await resolveInvoke()
  try {
    return await invoke(command, args)
  } catch (cause) {
    throw new PersistenceError(`本地命令「${command}」执行失败。`, 'TAURI_COMMAND_FAILED', cause)
  }
}

async function invokeCloseDecision(command: 'confirm_close' | 'cancel_close'): Promise<void> {
  await invokeCommand(command)
}

/** Tauri 2 adapter.  All desktop I/O stays behind the typed platform contract. */
export class DesktopLifePlatform implements LifePlatform {
  readonly kind = 'desktop' as const

  async loadSnapshot(): Promise<LoadSnapshotResult> {
    const raw = await invokeCommand('load_snapshot')
    // A brand-new repository may explicitly return null before its first
    // transaction.  That means an empty database, not a reason to load mocks.
    if (raw === null || raw === undefined) {
      const snapshot = makeSnapshot([], [], 0)
      return { snapshot, revision: 0 }
    }
    try {
      return normalizeLoadResult(raw)
    } catch (cause) {
      if (cause instanceof PersistenceError) throw cause
      throw new PersistenceError('无法读取本机资料库。', 'INVALID_SNAPSHOT', cause)
    }
  }

  async saveSnapshot(request: SaveSnapshotRequest): Promise<SaveSnapshotAck> {
    const raw = await invokeCommand('save_snapshot', {
      snapshot: request.snapshot,
      revision: request.revision,
    })
    return normalizeSaveAck(raw, request.revision)
  }

  async flush(revision = 0): Promise<FlushResult> {
    // The native command checkpoints the repository and takes no request
    // payload.  `revision` remains the renderer-side fallback only; passing
    // it as an unknown IPC field would make the command contract depend on
    // Tauri's argument leniency.
    const raw = await invokeCommand('flush_persistence')
    return normalizeFlushResult(raw, revision)
  }

  registerCloseHandler(flush: () => Promise<void>, onError?: (error: Error) => void): () => void {
    if (isAndroidRuntime()) {
      // Android may suspend the WebView without a desktop close event. The
      // normal save queue remains active; backgrounding adds a best-effort
      // flush of editor/IME work. Explicit Back/exit awaits the same barrier.
      let active = true
      let pending: Promise<void> | null = null
      const save = () => {
        // Once beforeunload has fired the WebView's Tauri callback registry is
        // being destroyed.  Do not start a second IPC flush from pagehide;
        // explicit actions and the Android background path flush beforehand.
        if (!active || isPageUnloading() || pending) return
        pending = flush().catch((cause: unknown) => {
          if (active) onError?.(new PersistenceError('切换到后台前未能完成本地保存，请返回应用后重试保存。', 'BACKGROUND_FLUSH_FAILED', cause))
        }).finally(() => { pending = null })
      }
      const onVisibility = () => { if (document.visibilityState === 'hidden') save() }
      const onBeforeUnload = () => { markPageUnloading() }
      document.addEventListener('visibilitychange', onVisibility)
      window.addEventListener('beforeunload', onBeforeUnload)
      window.addEventListener('pagehide', save)
      return () => {
        active = false
        document.removeEventListener('visibilitychange', onVisibility)
        window.removeEventListener('beforeunload', onBeforeUnload)
        window.removeEventListener('pagehide', save)
      }
    }
    let active = true
    let closeInProgress = false
    let unlisten: (() => void) | null = null

    const reportFailure = (message: string, code: string, cause: unknown) => {
      if (!active) return
      onError?.(new PersistenceError(message, code, cause))
    }

    // The Rust window handler prevents close, emits this event, and only
    // closes after confirm_close. Report failures through the store instead
    // of leaving a responsive window with an unexplained inactive close button.
    void listen('life-timeline://close-requested', async () => {
        if (!active || closeInProgress) return
        closeInProgress = true
        try {
          await flush()
          await invokeCloseDecision('confirm_close')
        } catch (cause) {
          reportFailure('关闭前未能完成本地保存，窗口已保留。请在设置中重试保存后再关闭。', 'CLOSE_FLUSH_FAILED', cause)
          // Keep the window open and leave the queue's failed snapshot intact.
          try {
            await invokeCloseDecision('cancel_close')
          } catch {
            // A second native failure is surfaced by the next normal retry;
            // do not turn it into an unhandled promise rejection on shutdown.
          }
        } finally {
          closeInProgress = false
        }
      })
      .then((dispose) => {
        if (!active) dispose()
        else unlisten = dispose
      })
      .catch((cause) => reportFailure('关闭保护暂时不可用，请先保留当前窗口并导出备份。', 'CLOSE_LISTENER_FAILED', cause))

    return () => {
      active = false
      unlisten?.()
      unlisten = null
    }
  }
}
