import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AppUpdaterController, AUTOMATIC_UPDATE_INTERVAL, desktopUpdaterGateway,
  androidUpdaterGateway,
  type AvailableUpdate, type UpdateCheckResult, type UpdateProgress, type UpdaterGateway, type UpdaterStatus,
} from '../lib/app-updater'
import { configureDesktopInvoker } from '../lib/desktop-commands'

const version = '0.2.0'
const available: AvailableUpdate = { token: 'checked-manifest', version, notes: '合成更新说明', publishedAt: '2026-10-01T00:00:00Z' }
const initial: UpdaterStatus = { currentVersion: '0.1.0', automaticCheck: true, ignoredVersion: null, lastCheckedAt: null, busy: null }
const nextTurn = () => new Promise<void>((done) => setImmediate(done))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function fixture(options: { status?: Partial<UpdaterStatus>; flush?: () => Promise<void> } = {}) {
  let status: UpdaterStatus = { ...initial, ...options.status }
  const calls: string[] = []
  let currentTime = 1_800_000_000_000
  let progressCallback: ((progress: UpdateProgress) => void) | null = null
  let result: UpdateCheckResult = { status: 'available', currentVersion: initial.currentVersion, update: available, checkedAt: '2026-10-01T00:00:00Z', ignoredVersion: status.ignoredVersion }
  const gateway: UpdaterGateway = {
    async status() { calls.push('status'); return status },
    async preferences(automaticCheck) { calls.push(`preferences:${automaticCheck}`); status = { ...status, automaticCheck }; return status },
    async check(manual) { calls.push(`check:${manual}`); return { ...result, ignoredVersion: status.ignoredVersion } },
    async ignore(nextVersion) { calls.push(`ignore:${nextVersion}`); status = { ...status, ignoredVersion: nextVersion }; return status },
    async download(token) { calls.push(`download:${token}`); return { downloadToken: 'verified-installer', version } },
    async install(token) { calls.push(`install:${token}`); return { installed: true } },
    async listenProgress(callback) { progressCallback = callback; return () => { progressCallback = null } },
  }
  const controller = new AppUpdaterController({
    gateway,
    flush: async () => { calls.push('flush'); await options.flush?.() },
    lockForInstall: (locked) => { calls.push(`lock:${locked}`) },
    now: () => currentTime,
  })
  return {
    controller, gateway, calls,
    setResult: (next: Partial<UpdateCheckResult>) => { result = { ...result, ...next } },
    advance: (time = AUTOMATIC_UPDATE_INTERVAL) => { currentTime += time },
    progress: (progress: UpdateProgress) => progressCallback?.(progress),
  }
}

test('automatic update check is opt-out, throttles reconnects and never downloads by itself', async () => {
  const f = fixture()
  await f.controller.initialize()
  await Promise.all([f.controller.check(), f.controller.check(), f.controller.check()])
  assert.equal(f.calls.filter((call) => call === 'check:false').length, 1)
  assert.equal(f.controller.getSnapshot().promptOpen, true)
  assert.equal(f.calls.some((call) => call.startsWith('download:')), false)
  await f.controller.check()
  assert.equal(f.calls.filter((call) => call === 'check:false').length, 1)
  await f.controller.setAutomaticCheck(false)
  f.advance()
  await f.controller.check()
  assert.equal(f.calls.filter((call) => call === 'check:false').length, 1)
  assert.equal(f.controller.getSnapshot().promptOpen, false)
  f.controller.dispose()
})

test('later suppresses the same version for this session but allows the next version', async () => {
  const f = fixture()
  await f.controller.initialize()
  await f.controller.check()
  f.controller.later()
  f.advance()
  await f.controller.check()
  assert.equal(f.controller.getSnapshot().promptOpen, false)
  f.setResult({ update: { ...available, version: '0.3.0', token: 'next-version' } })
  f.advance()
  await f.controller.check()
  assert.equal(f.controller.getSnapshot().promptOpen, true)
  assert.equal(f.controller.getSnapshot().update?.version, '0.3.0')
  assert.equal(f.calls.some((call) => call.startsWith('ignore:')), false)
  f.controller.dispose()
})

test('ignored version persists through native preferences while manual check bypasses ignore and automatic opt-out', async () => {
  const first = fixture()
  await first.controller.initialize()
  await first.controller.check()
  await first.controller.ignore()
  assert.equal(first.controller.getSnapshot().status?.ignoredVersion, version)
  assert.equal(first.controller.getSnapshot().promptOpen, false)
  const restarted = fixture({ status: { ignoredVersion: version } })
  await restarted.controller.initialize()
  await restarted.controller.check()
  assert.equal(restarted.controller.getSnapshot().promptOpen, false)
  await restarted.controller.setAutomaticCheck(false)
  await restarted.controller.check(true)
  assert.equal(restarted.controller.getSnapshot().promptOpen, true)
  assert.equal(restarted.controller.getSnapshot().manualPrompt, true)
  assert.equal(restarted.calls.some((call) => call.startsWith('download:')), false)
  first.controller.dispose()
  restarted.controller.dispose()
})

test('turning off automatic checks while a request is pending prevents its surprise prompt', async () => {
  const f = fixture()
  const pending = deferred<UpdateCheckResult>()
  f.gateway.check = async () => pending.promise
  await f.controller.initialize()
  const check = f.controller.check()
  await f.controller.setAutomaticCheck(false)
  pending.resolve({ status: 'available', update: available, currentVersion: '0.1.0', ignoredVersion: null, checkedAt: null })
  await check
  assert.equal(f.controller.getSnapshot().promptOpen, false)
  f.controller.dispose()
})

test('offline automatic checks remain quiet, online retry is limited, and manual failure is actionable', async () => {
  const f = fixture()
  f.setResult({ status: 'offline', update: null })
  await f.controller.initialize()
  await f.controller.check()
  assert.equal(f.controller.getSnapshot().error, null)
  assert.equal(f.controller.getSnapshot().promptOpen, false)
  f.advance(30_000)
  await f.controller.check()
  assert.equal(f.calls.filter((call) => call === 'check:false').length, 1)
  f.advance(30_000)
  await f.controller.check()
  assert.equal(f.calls.filter((call) => call === 'check:false').length, 2)
  await f.controller.check(true)
  assert.match(f.controller.getSnapshot().error ?? '', /离线使用/)
  f.controller.dispose()
})

test('a stalled native check returns the UI to idle with an actionable timeout', async () => {
  const f = fixture()
  f.gateway.check = () => new Promise<UpdateCheckResult>(() => {})
  const controller = new AppUpdaterController({
    gateway: f.gateway,
    flush: async () => {},
    lockForInstall: () => {},
    checkTimeoutMs: 10,
  })
  await controller.initialize()
  await controller.check(true)
  assert.equal(controller.getSnapshot().phase, 'idle')
  assert.match(controller.getSnapshot().error ?? '', /检查更新超时/)
  controller.dispose()
  f.controller.dispose()
})

test('restart delegates persisted success versus offline retry throttling to native code', async () => {
  const f = fixture({ status: { lastCheckedAt: new Date(1_800_000_000_000).toISOString() } })
  f.setResult({ status: 'throttled', update: null })
  await f.controller.initialize()
  await f.controller.check()
  assert.equal(f.calls.filter((call) => call === 'check:false').length, 1)
  f.advance(30_000)
  await f.controller.check()
  assert.equal(f.calls.filter((call) => call === 'check:false').length, 1)
  f.advance(30_000)
  f.setResult({ status: 'available', update: available })
  await f.controller.check()
  assert.equal(f.calls.filter((call) => call === 'check:false').length, 2)
  assert.equal(f.controller.getSnapshot().promptOpen, true)
  f.controller.dispose()
})

test('explicit update saves first, verifies download, locks input and saves again before install', async () => {
  const f = fixture()
  await f.controller.initialize()
  await f.controller.check(true)
  f.calls.length = 0
  await f.controller.downloadAndInstall()
  assert.deepEqual(f.calls, ['flush', 'download:checked-manifest', 'lock:true', 'flush', 'install:verified-installer', 'lock:false'])
  assert.equal(f.controller.getSnapshot().error, null)
  f.controller.dispose()
})

test('download can run in the background but installation waits for a fresh save', async () => {
  const f = fixture()
  const download = deferred<{ downloadToken: string; version: string }>()
  const secondSave = deferred<void>()
  let saves = 0
  const guarded = new AppUpdaterController({ gateway: f.gateway, flush: async () => { saves += 1; if (saves === 2) await secondSave.promise }, lockForInstall: (locked) => f.calls.push(`lock:${locked}`) })
  f.gateway.download = () => download.promise
  await guarded.initialize()
  await guarded.check(true)
  const updating = guarded.downloadAndInstall()
  await nextTurn()
  guarded.later()
  assert.equal(guarded.getSnapshot().phase, 'downloading')
  assert.equal(guarded.getSnapshot().promptOpen, false)
  assert.equal(saves, 1)
  download.resolve({ downloadToken: 'verified-installer', version })
  await nextTurn()
  assert.equal(saves, 2)
  assert.equal(guarded.getSnapshot().phase, 'finalizing')
  assert.equal(guarded.getSnapshot().promptOpen, true)
  assert.equal(f.calls.some((call) => call.startsWith('install:')), false)
  secondSave.resolve()
  await updating
  assert.equal(f.calls.filter((call) => call.startsWith('install:')).length, 1)
  guarded.dispose()
})

test('failed initial save prevents any download or install', async () => {
  const f = fixture({ flush: async () => { throw new Error('本地保存失败') } })
  await f.controller.initialize()
  await f.controller.check(true)
  await f.controller.downloadAndInstall()
  assert.match(f.controller.getSnapshot().error ?? '', /保存失败/)
  assert.equal(f.calls.some((call) => /^(download|install):/.test(call)), false)
  assert.equal(f.controller.getSnapshot().promptOpen, true)
  f.controller.dispose()
})

test('failed final save unlocks the app and never starts the verified installer', async () => {
  let saves = 0
  const f = fixture({ flush: async () => { if (++saves === 2) throw new Error('下载期间的编辑尚未保存') } })
  await f.controller.initialize()
  await f.controller.check(true)
  await f.controller.downloadAndInstall()
  assert.equal(f.calls.some((call) => call.startsWith('install:')), false)
  assert.equal(f.calls.at(-1), 'lock:false')
  assert.equal(f.controller.getSnapshot().phase, 'idle')
  assert.match(f.controller.getSnapshot().error ?? '', /尚未保存/)
  f.controller.dispose()
})

for (const problem of ['下载中断', '安装包签名无效']) {
  test(`${problem} cannot install and allows an explicit retry`, async () => {
    const f = fixture()
    await f.controller.initialize()
    await f.controller.check(true)
    const originalDownload = f.gateway.download
    f.gateway.download = async () => { throw new Error(problem) }
    await f.controller.downloadAndInstall()
    assert.equal(f.calls.some((call) => call.startsWith('install:')), false)
    assert.equal(f.calls.includes('lock:true'), false)
    assert.equal(f.controller.getSnapshot().error, problem)
    f.gateway.download = originalDownload
    await f.controller.downloadAndInstall()
    assert.equal(f.calls.filter((call) => call.startsWith('install:')).length, 1)
    f.controller.dispose()
  })
}

test('a missing or mismatched download token never reaches installation', async () => {
  for (const downloaded of [{ downloadToken: '', version }, { downloadToken: 'verified-other-version', version: '0.9.0' }]) {
    const f = fixture()
    f.gateway.download = async () => downloaded
    await f.controller.initialize()
    await f.controller.check(true)
    await f.controller.downloadAndInstall()
    assert.equal(f.calls.some((call) => call.startsWith('install:')), false)
    assert.match(f.controller.getSnapshot().error ?? '', /版本不一致/)
    f.controller.dispose()
  }
})

test('ready progress events cannot substitute for signature verification or trigger install twice', async () => {
  const f = fixture()
  const pending = deferred<{ downloadToken: string; version: string }>()
  f.gateway.download = () => pending.promise
  await f.controller.initialize()
  await f.controller.check(true)
  const updating = f.controller.downloadAndInstall()
  await nextTurn()
  f.progress({ phase: 'ready', version, downloadedBytes: 100, totalBytes: 100 })
  await f.controller.downloadAndInstall()
  assert.equal(f.calls.some((call) => call.startsWith('install:')), false)
  pending.reject(new Error('签名验证失败'))
  await updating
  assert.equal(f.calls.some((call) => call.startsWith('install:')), false)
  f.controller.dispose()
})

test('native update bridge uses typed requests and never accepts an executable URL from the renderer', async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = []
  configureDesktopInvoker(async <T>(command: string, args?: Record<string, unknown>) => { calls.push({ command, args }); return null as T })
  try {
    await desktopUpdaterGateway.status()
    await desktopUpdaterGateway.check(true)
    await desktopUpdaterGateway.preferences(false)
    await desktopUpdaterGateway.ignore(version)
    await desktopUpdaterGateway.download('manifest-token')
    await desktopUpdaterGateway.install('download-token')
    assert.deepEqual(calls, [
      { command: 'updater_status', args: undefined },
      { command: 'updater_check', args: { request: { manual: true } } },
      { command: 'updater_preferences', args: { request: { automaticCheck: false } } },
      { command: 'updater_ignore', args: { request: { version } } },
      { command: 'updater_download', args: { request: { token: 'manifest-token' } } },
      { command: 'updater_install', args: { request: { downloadToken: 'download-token', frontendFlushed: true } } },
    ])
  } finally { configureDesktopInvoker(null) }
})

test('Android update bridge uses separate opaque-token commands', async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = []
  configureDesktopInvoker(async <T>(command: string, args?: Record<string, unknown>) => { calls.push({ command, args }); return null as T })
  try {
    await androidUpdaterGateway.status()
    await androidUpdaterGateway.check(true)
    await androidUpdaterGateway.preferences(false)
    await androidUpdaterGateway.ignore(version)
    await androidUpdaterGateway.download('manifest-token')
    await androidUpdaterGateway.install('download-token')
    assert.deepEqual(calls.map(({ command, args }) => ({ command, args })), [
      { command: 'android_updater_status', args: undefined },
      { command: 'android_updater_check', args: { request: { manual: true } } },
      { command: 'android_updater_preferences', args: { request: { automaticCheck: false } } },
      { command: 'android_updater_ignore', args: { request: { version } } },
      { command: 'android_updater_download', args: { request: { token: 'manifest-token' } } },
      { command: 'android_updater_install', args: { request: { downloadToken: 'download-token', frontendFlushed: true } } },
    ])
  } finally { configureDesktopInvoker(null) }
})
