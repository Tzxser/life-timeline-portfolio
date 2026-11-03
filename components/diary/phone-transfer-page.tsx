'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Clipboard, ExternalLink, Link2, RefreshCw, Smartphone } from 'lucide-react'
import { listen } from '@tauri-apps/api/event'
import { DiaryExportIcon, DiaryImportIcon, PhoneComputerIcon } from '@/components/common/header-icons'
import { useLifeStore } from '@/lib/life-store'
import { isAndroidRuntime } from '@/lib/platform/runtime'
import { invokeDesktop } from '@/lib/desktop-commands'
import { createPhoneTransferLifecycle, type PhoneTransferLease } from '@/lib/phone-transfer-lifecycle'
import {
  chooseDiaryExportPath,
  chooseDiaryImportPath,
  exportDiaries,
  isDiaryDate,
} from '@/lib/diary-transfer'
import { DiaryPageFrame, errorText, fieldClass, primaryButton, quietButton } from './diary-page-frame'
import { isDailyEntry, todayKey } from '@/types/life-event'
import { cn } from '@/lib/utils'

export interface PhoneTransferSession {
  sessionId: string
  token: string
  url: string
  port: number
  expiresAt: string
  direction?: 'send' | 'receive'
  byteSize?: number
  sha256?: string
  diaryCount?: number | null
}

export interface PhoneTransferReceived {
  sessionId: string
  archivePath: string
  byteSize: number
  sha256: string
  receivedAt: string
}

interface PhoneTransferOfferRequest {
  archivePath?: string | null
  startDate?: string | null
  endDate?: string | null
}

interface PhoneTransferSent {
  sessionId: string
  byteSize: number
  sha256: string
}

interface PhoneTransferDownload {
  archivePath: string
  byteSize: number
  sha256: string
}

const desktopConnections = createPhoneTransferLifecycle<PhoneTransferSession, PhoneTransferOfferRequest>({
  start: (offer) => offer
    ? invokeDesktop<PhoneTransferSession>('phone_transfer_offer', { request: offer })
    : invokeDesktop<PhoneTransferSession>('phone_transfer_start'),
  cancel: (sessionId) => invokeDesktop<void>('phone_transfer_cancel', { sessionId }),
})

export function PhoneTransferPage({ onClose, onArchiveReceived }: {
  onClose: () => void
  onArchiveReceived?: (archivePath: string) => void
}) {
  const { platformKind } = useLifeStore()
  const android = isAndroidRuntime()
  const desktop = platformKind === 'desktop' && !android
  if (desktop) return <DesktopTransfer onClose={onClose} onArchiveReceived={onArchiveReceived} />
  if (android) return <AndroidTransfer onClose={onClose} onArchiveReceived={onArchiveReceived} />
  return <DiaryPageFrame mode="phone" busy={null} onClose={onClose}><BrowserTransfer /></DiaryPageFrame>
}

function DesktopTransfer({ onClose, onArchiveReceived }: {
  onClose: () => void
  onArchiveReceived?: (archivePath: string) => void
}) {
  const [direction, setDirection] = useState<'send' | 'receive'>('receive')
  return direction === 'receive'
    ? <DesktopReceive onClose={onClose} onArchiveReceived={onArchiveReceived} onDirectionChange={() => setDirection('send')} />
    : <DesktopSend onClose={onClose} onDirectionChange={() => setDirection('receive')} />
}

function DesktopReceive({ onClose, onArchiveReceived, onDirectionChange }: {
  onClose: () => void
  onArchiveReceived?: (archivePath: string) => void
  onDirectionChange: () => void
}) {
  const [session, setSession] = useState<PhoneTransferSession | null>(null)
  const [received, setReceived] = useState<PhoneTransferReceived | null>(null)
  const [busy, setBusy] = useState<string | null>('正在打开本机连接…')
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [closing, setClosing] = useState(false)
  const closingRef = useRef(false)
  const mountedRef = useRef(false)
  const closeRef = useRef<() => Promise<void>>(() => Promise.resolve())

  useEffect(() => {
    let active = true
    mountedRef.current = true
    let unlisten: (() => void) | undefined
    let lease: PhoneTransferLease<PhoneTransferSession> | undefined
    const stop = async () => {
      active = false
      unlisten?.()
      unlisten = undefined
      await lease?.close()
    }
    closeRef.current = stop
    const start = async () => {
      setBusy('正在打开本机连接…')
      setSession(null)
      setReceived(null)
      setError(null)
      try {
        const dispose = await listen<PhoneTransferReceived>('life-timeline://phone-transfer-received', (event) => {
          if (!active || event.payload.sessionId !== lease?.sessionId) return
          setReceived(event.payload)
          setBusy(null)
        })
        if (!active) { dispose(); return }
        unlisten = dispose
        lease = desktopConnections.open()
        const next = await lease.ready
        if (active) setSession(next)
      } catch (reason) {
        if (active) setError(errorText(reason, '无法打开本机连接，请稍后重试。'))
      } finally {
        if (active) setBusy(null)
      }
    }
    void start()
    return () => {
      mountedRef.current = false
      void stop().catch(() => { /* Native expiry remains the final cleanup fallback. */ })
    }
  }, [attempt])

  const close = async (afterClose = onClose) => {
    if (closingRef.current) return
    closingRef.current = true
    setClosing(true)
    try {
      await closeRef.current()
      if (mountedRef.current) afterClose()
    } catch (reason) {
      if (mountedRef.current) {
        setBusy(null)
        setError(errorText(reason, '结束连接没有完成，请再试一次。'))
      }
    } finally {
      closingRef.current = false
      if (mountedRef.current) setClosing(false)
    }
  }

  return (
    <DiaryPageFrame mode="phone" busy={closing ? '正在结束连接…' : null} onClose={() => void close()}>
    <section aria-label="连接手机">
      <DirectionSwitch direction="receive" desktop busy={Boolean(busy) || closing} onChange={(next) => { if (next !== 'receive') void close(onDirectionChange) }} />
      <h2 className="font-serif text-2xl leading-relaxed md:text-3xl">让手机把日记送回来</h2>
      <p className="mt-3 text-sm leading-7 text-muted-foreground">电脑只会在本机局域网短暂等待一份日记 ZIP。连接会在页面关闭或过期后失效，不会上传到互联网。</p>
      {busy && <p role="status" className="mt-7 text-sm text-muted-foreground">{busy}</p>}
      {error && <p role="alert" className="mt-6 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm leading-7 text-destructive">{error}</p>}
      {!session && !busy && (
        <button type="button" disabled={closing} className={cn(primaryButton, 'lt-hbtn mt-7 inline-flex items-center gap-2')} onClick={() => setAttempt((current) => current + 1)}><RefreshCw className="size-4" />重新打开连接</button>
      )}
      {session && (
        <>
          <ConnectionDetails session={session} direction="receive" />
          {received
            ? <div className="mt-8 rounded-xl border border-primary/30 bg-primary/5 px-5 py-5" role="status">
              <div className="flex items-start gap-3"><span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border border-primary/30 text-primary"><Check className="size-4" /></span><div><p className="font-serif text-lg">手机日记已到达</p><p className="mt-2 text-sm leading-7 text-muted-foreground">已收到 {formatBytes(received.byteSize)} 的日记包。检查日期冲突后才会写入这台电脑。</p></div></div>
              <div className="mt-5 flex flex-wrap gap-3"><button type="button" disabled={closing} className={primaryButton} onClick={() => void close(() => onArchiveReceived?.(received.archivePath))}>检查并导入</button><button type="button" disabled={closing} className={quietButton} onClick={() => setReceived(null)}>稍后处理</button></div>
            </div>
            : <div className="mt-8 flex items-center gap-3 rounded-lg border border-dashed border-border px-4 py-4 text-sm text-muted-foreground"><Smartphone className="size-4 shrink-0" />等待手机发送日记 ZIP…</div>}
        </>
      )}
      <button type="button" disabled={closing} className={cn(quietButton, 'mt-8')} onClick={() => void close()}>结束连接并返回</button>
    </section>
    </DiaryPageFrame>
  )
}

interface DesktopOfferOwner {
  active: boolean
  lease?: PhoneTransferLease<PhoneTransferSession>
  unlisten?: () => void
}

async function releaseDesktopOffer(owner: DesktopOfferOwner): Promise<void> {
  owner.unlisten?.()
  owner.unlisten = undefined
  const lease = owner.lease
  await lease?.close()
  if (owner.lease === lease) owner.lease = undefined
}

function DesktopSend({ onClose, onDirectionChange }: {
  onClose: () => void
  onDirectionChange: () => void
}) {
  const { events, flushPersistence } = useLifeStore()
  const diaries = useMemo(() => events.filter(isDailyEntry).sort((a, b) => a.date.localeCompare(b.date)), [events])
  const [scope, setScope] = useState<'all' | 'range'>('all')
  const [startDate, setStartDate] = useState(diaries[0]?.date ?? todayKey())
  const [endDate, setEndDate] = useState(diaries[diaries.length - 1]?.date ?? todayKey())
  const [session, setSession] = useState<PhoneTransferSession | null>(null)
  const [sent, setSent] = useState<PhoneTransferSent | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const workingRef = useRef(false)
  const ownerRef = useRef<DesktopOfferOwner | null>(null)
  const rangeError = scope === 'range' && (!isDiaryDate(startDate) || !isDiaryDate(endDate) || startDate > endDate)
    ? '请选择有效的日期区间，开始日期不能晚于结束日期。' : null
  const selectedCount = scope === 'all' ? diaries.length : diaries.filter((entry) => entry.date >= startDate && entry.date <= endDate).length

  useEffect(() => {
    const owner: DesktopOfferOwner = { active: true }
    ownerRef.current = owner
    return () => {
      owner.active = false
      void releaseDesktopOffer(owner).catch(() => { /* Native expiry remains the final cleanup fallback. */ })
    }
  }, [])

  const prepare = async (kind: 'export' | 'existing') => {
    const owner = ownerRef.current
    if (!owner?.active || workingRef.current || session) return
    setError(null)
    setNotice(null)
    if (kind === 'export' && (rangeError || selectedCount === 0)) {
      setError(rangeError ?? '所选范围内还没有可发送的日记。')
      return
    }
    workingRef.current = true
    setSent(null)
    setBusy(kind === 'export' ? '正在保存并打包日记…' : '正在选择日记 ZIP…')
    try {
      await releaseDesktopOffer(owner)
      await flushPersistence()
      if (!owner.active) return
      let archivePath: string | null = null
      if (kind === 'existing') {
        archivePath = await chooseDiaryImportPath()
        if (!owner.active) return
        if (!archivePath) { setNotice('已取消选择文件。'); return }
      }
      const dispose = await listen<PhoneTransferSent>('life-timeline://phone-transfer-sent', (event) => {
        if (owner.active && event.payload.sessionId === owner.lease?.sessionId) setSent(event.payload)
      })
      if (!owner.active) { dispose(); return }
      owner.unlisten = dispose
      owner.lease = desktopConnections.open({
        archivePath,
        startDate: kind === 'export' && scope === 'range' ? startDate : null,
        endDate: kind === 'export' && scope === 'range' ? endDate : null,
      })
      const next = await owner.lease.ready
      if (owner.active) setSession(next)
    } catch (reason) {
      if (owner.active) setError(errorText(reason, '日记包没有准备完成，请稍后重试。'))
    } finally {
      workingRef.current = false
      if (owner.active) setBusy(null)
    }
  }

  const close = async (afterClose = onClose) => {
    const owner = ownerRef.current
    if (!owner?.active || workingRef.current) return
    workingRef.current = true
    setBusy('正在结束连接…')
    try {
      await releaseDesktopOffer(owner)
      if (owner.active) afterClose()
    } catch (reason) {
      if (owner.active) setError(errorText(reason, '结束连接没有完成，请再试一次。'))
    } finally {
      workingRef.current = false
      if (owner.active) setBusy(null)
    }
  }

  return (
    <DiaryPageFrame mode="phone" busy={busy} onClose={() => void close()}>
      <section aria-label="发送到手机">
        <DirectionSwitch direction="send" desktop busy={Boolean(busy)} onChange={(next) => { if (next !== 'send') void close(onDirectionChange) }} />
        <h2 className="font-serif text-2xl leading-relaxed md:text-3xl">把电脑日记送到手机</h2>
        <p className="mt-3 text-sm leading-7 text-muted-foreground">选好要带走的日记，再在手机上选择「接收电脑」。文字、图片和附件会随日记包一同传送，手机检查冲突后才会写入。</p>
        {!session && <>
          <TransferScopeFields scope={scope} onScopeChange={setScope} startDate={startDate} onStartChange={setStartDate} endDate={endDate} onEndChange={setEndDate} count={diaries.length} busy={Boolean(busy)} />
          {rangeError && <p role="alert" className="mt-4 text-sm text-destructive">{rangeError}</p>}
          <div className="mt-8 flex flex-wrap gap-3">
            <button type="button" disabled={Boolean(busy)} className={cn(primaryButton, 'lt-hbtn inline-flex items-center gap-2')} onClick={() => void prepare('export')}><DiaryExportIcon className="size-4" />打包并准备发送</button>
            <button type="button" disabled={Boolean(busy)} className={cn(quietButton, 'lt-hbtn inline-flex items-center gap-2')} onClick={() => void prepare('existing')}><ExternalLink className="size-4" />发送已有 ZIP</button>
          </div>
        </>}
        {session && !sent && <>
          <p className="mt-7 text-sm text-muted-foreground">已准备{session.diaryCount != null ? ` ${session.diaryCount} 篇日记，` : '日记包，'}{formatBytes(session.byteSize ?? 0)}。</p>
          <ConnectionDetails session={session} direction="send" />
          <div className="mt-8 flex items-center gap-3 rounded-lg border border-dashed border-border px-4 py-4 text-sm text-muted-foreground"><Smartphone className="size-4 shrink-0" />等待手机接收日记 ZIP…</div>
          <div className="mt-4"><button type="button" disabled={Boolean(busy)} className={cn(quietButton, 'lt-hbtn inline-flex items-center gap-2')} onClick={() => void close(() => { setSession(null); setSent(null); setError(null); setNotice('原连接已结束，请重新准备要发送的日记包。') })}><RefreshCw className="size-4" />重新准备连接</button><p className="mt-3 text-xs leading-6 text-muted-foreground">接收中断、连接过期或想调整日记范围时，可以重新准备。</p></div>
        </>}
        {sent && <div className="mt-8 rounded-xl border border-primary/30 bg-primary/5 px-5 py-5" role="status">
          <div className="flex items-start gap-3"><Check className="mt-1 size-5 shrink-0 text-primary" /><div><p className="font-serif text-lg">日记包已传出</p><p className="mt-2 text-sm leading-7 text-muted-foreground">已传送 {formatBytes(sent.byteSize)}。请在手机上检查并导入，处理日期冲突后才会保存。本次连接码已失效。</p></div></div>
          <button type="button" disabled={Boolean(busy)} className={cn(quietButton, 'mt-5')} onClick={() => void close(() => { setSession(null); setSent(null); setError(null) })}>再传一份</button>
        </div>}
        {notice && <p role="status" className="mt-5 text-sm text-muted-foreground">{notice}</p>}
        {error && <p role="alert" className="mt-5 text-sm leading-7 text-destructive">{error}</p>}
        <p className="mt-6 text-xs leading-6 text-muted-foreground">连接只在本机网络中临时开放，关闭页面或十分钟后失效。日记包不包含 API 密钥。</p>
        <button type="button" disabled={Boolean(busy)} className={cn(quietButton, 'mt-8')} onClick={() => void close()}>结束连接并返回</button>
      </section>
    </DiaryPageFrame>
  )
}

function AndroidTransfer({ onClose, onArchiveReceived }: {
  onClose: () => void
  onArchiveReceived?: (archivePath: string) => void
}) {
  const { events, flushPersistence } = useLifeStore()
  const diaries = useMemo(() => events.filter(isDailyEntry).sort((a, b) => a.date.localeCompare(b.date)), [events])
  const [direction, setDirection] = useState<'send' | 'receive'>('send')
  const [serverUrl, setServerUrl] = useState('http://')
  const [token, setToken] = useState('')
  const [scope, setScope] = useState<'all' | 'range'>('all')
  const [startDate, setStartDate] = useState(diaries[0]?.date ?? todayKey())
  const [endDate, setEndDate] = useState(diaries[diaries.length - 1]?.date ?? todayKey())
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [received, setReceived] = useState<PhoneTransferDownload | null>(null)
  const sendingRef = useRef(false)
  const rangeError = scope === 'range' && (!isDiaryDate(startDate) || !isDiaryDate(endDate) || startDate > endDate)
    ? '请选择有效的日期区间，开始日期不能晚于结束日期。' : null

  const send = async (kind: 'export' | 'existing') => {
    if (sendingRef.current) return
    setError(null); setNotice(null)
    if (!validServerUrl(serverUrl)) { setError('请输入电脑显示的本机地址，例如 http://192.168.1.20:18741。临时联动只接受本机网络 HTTP 地址。'); return }
    if (!/^[a-f0-9]{32}$/i.test(token.trim())) { setError('请输入电脑显示的 32 位连接码。'); return }
    if (kind === 'export' && (rangeError || diaries.length === 0)) { setError(rangeError ?? '还没有可发送的日记。'); return }
    sendingRef.current = true
    try {
      setBusy(kind === 'export' ? '正在保存并打包日记…' : '正在选择日记 ZIP…')
      await flushPersistence()
      const archivePath = kind === 'export'
        ? await chooseDiaryExportPath()
        : await chooseDiaryImportPath()
      if (!archivePath) { setNotice('已取消选择文件。'); return }
      let path = archivePath
      if (kind === 'export') {
        const exported = await exportDiaries({ destinationPath: archivePath, startDate: scope === 'range' ? startDate : null, endDate: scope === 'range' ? endDate : null, overwrite: true })
        path = exported.archivePath
      }
      setBusy('正在通过本机连接发送…')
      await invokeDesktop('phone_transfer_send', { request: { serverUrl: serverUrl.trim(), token: token.trim(), archivePath: path } })
      setNotice('日记已发送。电脑端会在检查冲突后决定是否导入。')
    } catch (reason) {
      setError(errorText(reason, '发送没有完成，请检查地址、连接码和两台设备的网络。'))
    } finally { sendingRef.current = false; setBusy(null) }
  }

  const receive = async () => {
    if (sendingRef.current || received) return
    setError(null); setNotice(null)
    if (!validServerUrl(serverUrl)) { setError('请输入电脑「发送到手机」页面显示的完整本机 HTTP 地址。'); return }
    if (!/^[a-f0-9]{32}$/i.test(token.trim())) { setError('请输入电脑显示的 32 位连接码。'); return }
    sendingRef.current = true
    setBusy('正在接收电脑的日记包…')
    try {
      await flushPersistence()
      const result = await invokeDesktop<PhoneTransferDownload>('phone_transfer_receive', { request: { serverUrl: serverUrl.trim(), token: token.trim() } })
      setReceived(result)
    } catch (reason) {
      setError(errorText(reason, '接收没有完成，请检查电脑连接是否仍然有效，或在电脑上重新生成连接码。'))
    } finally { sendingRef.current = false; setBusy(null) }
  }

  const switchDirection = (next: 'send' | 'receive') => {
    if (sendingRef.current || next === direction) return
    setDirection(next)
    setError(null)
    setNotice(null)
    setReceived(null)
    setServerUrl('http://')
    setToken('')
  }

  return (
    <DiaryPageFrame mode="phone" busy={busy} onClose={() => { if (!sendingRef.current) onClose() }}>
    <section aria-label="连接电脑">
      <DirectionSwitch direction={direction} busy={Boolean(busy)} onChange={switchDirection} />
      <h2 className="font-serif text-2xl leading-relaxed md:text-3xl">{direction === 'send' ? '把手机日记送到电脑' : '把电脑日记接到手机'}</h2>
      <p className="mt-3 text-sm leading-7 text-muted-foreground">{direction === 'send' ? '在电脑端选择「接收手机」，把地址和连接码填在这里。' : '在电脑端选择「发送到手机」并准备好日记包，把地址和连接码填在这里。'}数据只在两台设备的本机网络中传送。</p>
      <fieldset disabled={Boolean(busy) || Boolean(received)} className="mt-8 space-y-5">
        <legend className="sr-only">连接信息</legend>
        <label className="block text-sm"><span className="mb-2 block text-xs text-muted-foreground">电脑地址</span><input inputMode="url" autoCapitalize="none" spellCheck={false} value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} placeholder="http://192.168.1.20:18741/api/v1/phone-transfer" className={fieldClass} /></label>
        <label className="block text-sm"><span className="mb-2 block text-xs text-muted-foreground">连接码</span><input inputMode="text" autoCapitalize="none" spellCheck={false} autoComplete="one-time-code" value={token} onChange={(event) => setToken(event.target.value)} placeholder="填写电脑上显示的连接码" className={fieldClass} /></label>
      </fieldset>
      {direction === 'send' && <>
        <TransferScopeFields scope={scope} onScopeChange={setScope} startDate={startDate} onStartChange={setStartDate} endDate={endDate} onEndChange={setEndDate} count={diaries.length} busy={Boolean(busy)} />
        {rangeError && <p role="alert" className="mt-4 text-sm text-destructive">{rangeError}</p>}
        <div className="mt-8 flex flex-wrap gap-3"><button type="button" disabled={Boolean(busy)} className={cn(primaryButton, 'lt-hbtn inline-flex items-center gap-2')} onClick={() => void send('export')}><Link2 className="size-4" />打包并发送</button><button type="button" disabled={Boolean(busy)} className={cn(quietButton, 'inline-flex items-center gap-2')} onClick={() => void send('existing')}><ExternalLink className="size-4" />发送已有 ZIP</button></div>
        <p className="mt-6 text-xs leading-6 text-muted-foreground">发送前会先完成本机保存。ZIP 仍会留在你选择的手机位置，日记包不包含 API 密钥。</p>
      </>}
      {direction === 'receive' && (received
        ? <div className="mt-8 rounded-xl border border-primary/30 bg-primary/5 px-5 py-5" role="status">
          <div className="flex items-start gap-3"><Check className="mt-1 size-5 shrink-0 text-primary" /><div><p className="font-serif text-lg">电脑日记已到达</p><p className="mt-2 text-sm leading-7 text-muted-foreground">已收到 {formatBytes(received.byteSize)}。检查日期冲突并确认导入后才会写入手机，现有日记尚未改变。</p></div></div>
          <div className="mt-5 flex flex-wrap gap-3"><button type="button" disabled={Boolean(busy)} className={primaryButton} onClick={() => { if (!sendingRef.current) onArchiveReceived?.(received.archivePath) }}>检查并导入</button><button type="button" disabled={Boolean(busy)} className={quietButton} onClick={() => { setReceived(null); setToken('') }}>再接收一份</button></div>
        </div>
        : <div className="mt-8"><button type="button" disabled={Boolean(busy)} className={cn(primaryButton, 'lt-hbtn inline-flex items-center gap-2')} onClick={() => void receive()}><DiaryImportIcon className="size-4" />接收日记</button><p className="mt-5 text-xs leading-6 text-muted-foreground">连接码仅可使用一次。接收后会保留文字、图片、附件和日记排版，再由你决定日期冲突的处理方式。</p></div>)}
      {notice && <p role="status" className="mt-5 text-sm text-muted-foreground">{notice}</p>}
      {error && <p role="alert" className="mt-5 text-sm leading-7 text-destructive">{error}</p>}
    </section>
    </DiaryPageFrame>
  )
}

function DirectionSwitch({ direction, desktop = false, busy, onChange }: {
  direction: 'send' | 'receive'
  desktop?: boolean
  busy: boolean
  onChange: (direction: 'send' | 'receive') => void
}) {
  const choices: Array<'send' | 'receive'> = desktop ? ['receive', 'send'] : ['send', 'receive']
  return <div role="group" aria-label="传送方向" className="mb-8 grid grid-cols-2 gap-2 rounded-xl border border-border bg-muted/20 p-1.5">
    {choices.map((value) => {
      const Icon = value === 'send' ? DiaryExportIcon : DiaryImportIcon
      const label = desktop ? (value === 'send' ? '发送到手机' : '接收手机') : (value === 'send' ? '发送到电脑' : '接收电脑')
      return <button key={value} type="button" aria-pressed={direction === value} disabled={busy} onClick={() => onChange(value)} className={cn('lt-hbtn flex items-center justify-center gap-2 rounded-lg px-3 py-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-40', direction === value ? 'bg-background text-primary shadow-sm' : 'text-muted-foreground hover:bg-background/70 hover:text-foreground')}><Icon className="size-4" />{label}</button>
    })}
  </div>
}

function TransferScopeFields({ scope, onScopeChange, startDate, onStartChange, endDate, onEndChange, count, busy }: {
  scope: 'all' | 'range'
  onScopeChange: (scope: 'all' | 'range') => void
  startDate: string
  onStartChange: (date: string) => void
  endDate: string
  onEndChange: (date: string) => void
  count: number
  busy: boolean
}) {
  return <fieldset disabled={busy} className="mt-8"><legend className="mb-3 text-xs text-muted-foreground">发送范围</legend><div className="grid gap-3 sm:grid-cols-2"><label className={cn('cursor-pointer rounded-lg border px-4 py-4 transition-colors hover:bg-muted/40', scope === 'all' ? 'border-primary/50 bg-primary/5' : 'border-border')}><input type="radio" name="phone-transfer-scope" checked={scope === 'all'} onChange={() => onScopeChange('all')} className="mr-2 accent-primary" />全部日记<span className="mt-1 block pl-5 text-xs text-muted-foreground">共 {count} 篇</span></label><label className={cn('cursor-pointer rounded-lg border px-4 py-4 transition-colors hover:bg-muted/40', scope === 'range' ? 'border-primary/50 bg-primary/5' : 'border-border')}><input type="radio" name="phone-transfer-scope" checked={scope === 'range'} onChange={() => onScopeChange('range')} className="mr-2 accent-primary" />指定日期区间<span className="mt-1 block pl-5 text-xs text-muted-foreground">只发送选中的日子</span></label></div>{scope === 'range' && <div className="mt-4 grid gap-4 sm:grid-cols-2"><label className="text-xs text-muted-foreground">开始日期<input type="date" value={startDate} onChange={(event) => onStartChange(event.target.value)} className={cn(fieldClass, 'mt-2')} /></label><label className="text-xs text-muted-foreground">结束日期<input type="date" value={endDate} onChange={(event) => onEndChange(event.target.value)} className={cn(fieldClass, 'mt-2')} /></label></div>}</fieldset>
}

function ConnectionDetails({ session, direction }: { session: PhoneTransferSession; direction: 'send' | 'receive' }) {
  const [copied, setCopied] = useState<string | null>(null)
  const [copyError, setCopyError] = useState(false)
  const mountedRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false; if (timerRef.current) clearTimeout(timerRef.current) }
  }, [])
  const copy = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      if (!mountedRef.current) return
      setCopied(label)
      setCopyError(false)
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setCopied(null), 1600)
    } catch { if (mountedRef.current) setCopyError(true) }
  }
  return <>
    <div className="mt-8 grid gap-5 rounded-xl border border-border p-5 md:grid-cols-[1fr_auto] md:items-center">
      <div><p className="text-xs tracking-wide text-muted-foreground">在手机的「{direction === 'send' ? '接收电脑' : '发送到电脑'}」中填写这个地址</p><p className="mt-2 break-all font-mono text-sm leading-7 text-foreground">{session.url}</p><p className="mt-3 text-xs leading-6 text-muted-foreground">地址只在当前网络可用；如果手机无法打开，请确认两台设备连在同一个 Wi‑Fi。</p></div>
      <button type="button" className={cn(quietButton, 'inline-flex items-center justify-center gap-2')} onClick={() => void copy('url', session.url)}><Clipboard className="size-4" />{copied === 'url' ? '已复制' : '复制地址'}</button>
    </div>
    <div className="mt-4 rounded-xl border border-border bg-muted/30 px-5 py-6 text-center"><p className="text-xs tracking-wide text-muted-foreground">连接码</p><p className="mt-2 break-all select-all font-mono text-2xl tracking-[0.18em] text-foreground sm:text-3xl">{session.token}</p><button type="button" className="lt-hbtn mt-4 inline-flex items-center gap-2 rounded-md px-3 py-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => void copy('token', session.token)}><Clipboard className="size-3.5" />{copied === 'token' ? '已复制连接码' : '复制连接码'}</button></div>
    <p className="mt-4 text-xs leading-6 text-muted-foreground">本次连接将在 {formatExpiry(session.expiresAt)} 自动结束。连接码仅可使用一次。</p>
    {copyError && <p role="alert" className="mt-4 text-sm text-destructive">当前系统不允许自动复制，请手动选择并复制。</p>}
  </>
}

function BrowserTransfer() {
  return <section aria-label="连接手机"><h2 className="font-serif text-2xl leading-relaxed md:text-3xl">电脑与手机临时联动</h2><p className="mt-3 text-sm leading-7 text-muted-foreground">浏览器预览不会开启本机连接。请在 Windows 桌面版与 Android 应用中使用这个页面；连接只在两台设备的本机网络中存在。</p><div className="mt-8 rounded-xl border border-dashed border-border px-5 py-6 text-sm leading-7 text-muted-foreground"><PhoneComputerIcon className="mb-4 size-8" />打开桌面版后，这里会显示一次性的地址和连接码。</div></section>
}

function validServerUrl(raw: string): boolean {
  try {
    const url = new URL(raw.trim())
    return url.protocol === 'http:' && !url.username && !url.password && Boolean(url.hostname)
  } catch { return false }
}

function formatExpiry(raw: string): string {
  const value = Date.parse(raw)
  return Number.isNaN(value) ? '稍后' : new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(value)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
