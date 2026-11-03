'use client'

import { RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { isAndroidRuntime } from '@/lib/platform/runtime'
import { useAppUpdater } from './app-update-provider'

export function UpdateSettingsSection() {
  const { controller, state } = useAppUpdater()
  const [android, setAndroid] = useState(false)
  useEffect(() => setAndroid(isAndroidRuntime()), [])
  if (!controller) return null
  const busy = state.phase !== 'idle'
  const checkedAt = state.status?.lastCheckedAt ? new Date(state.status.lastCheckedAt) : null
  return (
    <section aria-label="软件更新" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2"><h3 className="font-serif text-sm text-foreground">软件更新</h3>{state.status && <span className="font-mono text-xs text-muted-foreground">v{state.status.currentVersion}</span>}</div>
      <p className="text-xs leading-relaxed text-muted-foreground/70">{android ? '联网后检查新版本。Android 网络访问属于系统普通权限，不会在权限列表中单独显示或弹出授权框。下载完成后会打开 Android 系统安装界面，由你确认覆盖安装；不会上传日记或 API 配置。' : '联网后检查新版本，下载和安装由你决定。检查更新只读取版本信息，不上传日记或 API 配置。'}</p>
      <label className="flex cursor-pointer items-center justify-between gap-3 rounded-md border border-border px-3 py-2.5 transition-colors hover:border-foreground/30">
        <span className="flex flex-col gap-0.5"><span className="text-sm text-foreground">自动检查更新</span><span className="text-xs text-muted-foreground/60">忽略的版本不再提醒，下一个新版本仍会提示</span></span>
        <input type="checkbox" className="size-4 accent-primary" checked={state.status?.automaticCheck ?? false} disabled={!state.status || state.savingPreferences} onChange={(event) => void controller.setAutomaticCheck(event.target.checked)} />
      </label>
      <button type="button" disabled={busy} onClick={() => void controller.check(true)} className="inline-flex items-center justify-center gap-2 self-start rounded-md border border-border px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"><RefreshCw className={`size-3.5 ${state.phase === 'checking' ? 'animate-spin motion-reduce:animate-none' : ''}`} />{state.phase === 'checking' ? '正在检查…' : '检查更新'}</button>
      {state.status?.ignoredVersion && <p className="text-xs text-muted-foreground/60">已忽略 v{state.status.ignoredVersion}，手动检查仍可查看和更新。</p>}
      {checkedAt && Number.isFinite(checkedAt.getTime()) && <p className="text-xs text-muted-foreground/60">上次检查：{checkedAt.toLocaleString('zh-CN')}</p>}
      {state.notice && <p role="status" className="text-xs leading-relaxed text-muted-foreground">{state.notice}</p>}
      {state.error && <p role="alert" className="text-xs leading-relaxed text-destructive">{state.error}</p>}
    </section>
  )
}
