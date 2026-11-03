// Test-only shared utilities. Every native session is a newly launched EXE,
// under an explicit isolated identifier/data root and an owned loopback port.
// Does not build/install, read personal AppData, or force-kill a process.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import net from 'node:net'
import path from 'node:path'
import process from 'node:process'

export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
export const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
export const ordered = (value) => Array.isArray(value) ? value.map(ordered)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, ordered(value[key])])) : value
export const fingerprint = (value) => sha256(JSON.stringify(ordered(value)))
export const below = (root, candidate) => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

export async function until(read, message, timeout = 15_000) {
  const deadline = Date.now() + timeout
  do {
    if (await read()) return
    await pause(100)
  } while (Date.now() < deadline)
  throw new Error(message)
}

export async function run(program, parameters, options = {}) {
  return new Promise((resolve, reject) => {
    const command = spawn(program, parameters, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options })
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => reject(new Error(`${program} timed out; no process was killed`)), 30_000)
    command.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    command.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    command.on('error', (error) => { clearTimeout(timeout); reject(error) })
    command.on('exit', (code) => {
      clearTimeout(timeout)
      if (code === 0) resolve(stdout)
      else reject(new Error(`${program} exited ${code}: ${stderr.trim().slice(0, 1500)}`))
    })
  })
}

export async function noRedirect(target) {
  let current = path.resolve(target)
  while (true) {
    const item = await fs.lstat(current).catch((error) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (item) {
      assert(!item.isSymbolicLink(), 'Refusing a junction/symlink in fixture path')
      assert(samePath(await fs.realpath(current), current), 'Refusing redirected fixture path')
    }
    const parent = path.dirname(current)
    if (parent === current) return
    current = parent
  }
}

export function localChromium(root) {
  const require = createRequire(import.meta.url)
  for (const candidate of [process.env.LIFE_TIMELINE_PLAYWRIGHT_MODULE,
    path.join(root, 'node_modules', 'playwright'),
    path.join(process.env.USERPROFILE ?? '', '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')].filter(Boolean)) {
    try { return require(candidate).chromium } catch { /* already installed runtime only */ }
  }
  throw new Error('No already installed Playwright runtime')
}

export const invoke = (page, command, payload) => page.evaluate(({ command, payload }) => {
  if (typeof window.__TAURI_INTERNALS__?.invoke !== 'function') throw new Error('No native IPC')
  return window.__TAURI_INTERNALS__.invoke(command, payload)
}, { command, payload })

export const rejection = (page, command, payload) => page.evaluate(async ({ command, payload }) => {
  try { await window.__TAURI_INTERNALS__.invoke(command, payload); return { rejected: false, code: null } }
  catch (error) { return { rejected: true, code: typeof error?.code === 'string' ? error.code : null } }
}, { command, payload })

export async function sqliteSnapshot(dataDir) {
  const database = path.join(dataDir, 'life-timeline.sqlite')
  await noRedirect(database)
  return JSON.parse(await run('python', ['-c', `
import json,pathlib,sqlite3,sys
p=pathlib.Path(sys.argv[1]).resolve(strict=True)
assert str(p).lower()==str(pathlib.Path(sys.argv[2])/'life-timeline.sqlite').lower()
c=sqlite3.connect(p.as_uri()+'?mode=ro',uri=True,timeout=5)
c.execute('PRAGMA query_only=ON');c.row_factory=sqlite3.Row
ignored={'revision','created_at','updated_at','sort_order'}
tables={name:[{k:r[k] for k in r.keys() if k not in ignored} for r in c.execute('SELECT * FROM '+name+' ORDER BY 1')] for name in ['events','stages','attachments','attachment_blobs','preferences']}
tables['meta']=dict(c.execute('SELECT key,value FROM meta'))
tables['integrity']=c.execute('PRAGMA integrity_check').fetchone()[0]
tables['foreignKeys']=[list(r) for r in c.execute('PRAGMA foreign_key_check')]
c.close();print(json.dumps(tables,ensure_ascii=True))
`, database, dataDir]))
}

export const semanticDisk = (disk) => ({ events: disk.events, stages: disk.stages, attachments: disk.attachments,
  blobs: disk.attachment_blobs, preferences: disk.preferences })

export class NativeFixture {
  constructor({ root, exe, dataDir, identifier, port, report, validateDisk, externalFixtureRoot = null }) {
    if (externalFixtureRoot !== null) {
      assert.equal(identifier, 'com.tzxser.lifetimeline.ai-live', 'External fixture requires its dedicated identifier')
      assert.equal(path.basename(path.dirname(externalFixtureRoot)).toLowerCase(), 'life-timeline-private')
      assert(/^ai-live-[a-z0-9-]+$/i.test(path.basename(externalFixtureRoot)), 'Unexpected external fixture directory')
      assert(samePath(dataDir, path.join(externalFixtureRoot, 'data')), 'External fixture data must be its exact data directory')
      assert(!below(root, externalFixtureRoot), 'External provider fixtures must remain outside the project')
    } else {
      assert(below(path.join(root, 'test-data'), dataDir), 'Native fixture data must stay below project test-data')
    }
    assert.notEqual(identifier, 'com.tzxser.lifetimeline', 'Never use the personal application identifier in an isolated fixture')
    Object.assign(this, { root, exe, dataDir, identifier, port, report, validateDisk, externalFixtureRoot })
    this.chromium = localChromium(root)
    this.child = null
    this.browser = null
    this.page = null
    this.observed = []
    this.errors = []
  }

  async guardExternalRoot(disk = null) {
    if (this.externalFixtureRoot === null) return
    await noRedirect(this.externalFixtureRoot)
    await noRedirect(this.dataDir)
    const markerPath = path.join(this.dataDir, '.life-timeline-live-fixture.json')
    await noRedirect(markerPath)
    const marker = JSON.parse(await fs.readFile(markerPath, 'utf8'))
    assert.equal(marker.purpose, 'synthetic-live-provider-test')
    assert.equal(marker.identifier, this.identifier)
    assert(samePath(marker.dataDir, this.dataDir))
    assert.equal(marker.syntheticMarker, '【合成AI真实接口验收】')
    if (disk) {
      assert.equal(disk.stages.length, 0, 'External fixture must not contain life stages')
      assert(disk.events.length <= 300 && disk.attachments.length <= 500, 'External fixture exceeded its synthetic limits')
      assert(disk.events.every((event) => event.title.startsWith(marker.syntheticMarker)), 'Refusing non-synthetic external diary content')
      if (marker.databaseId) assert.equal(disk.meta.databaseId, marker.databaseId, 'External fixture database identity changed')
      else assert.equal(disk.events.length + disk.attachments.length + disk.attachment_blobs.length, 0, 'Unidentified external fixture must be empty')
    }
  }

  async portFree() {
    await new Promise((resolve, reject) => {
      const server = net.createServer()
      server.once('error', () => reject(new Error('Fixture CDP port occupied; refusing an existing process')))
      server.listen(this.port, '127.0.0.1', () => server.close((error) => error ? reject(error) : resolve()))
    })
  }

  async guard() {
    assert.equal(await invoke(this.page, 'plugin:app|identifier'), this.identifier)
    assert(samePath(await invoke(this.page, 'plugin:path|resolve_directory', { directory: 15 }), this.dataDir))
    const disk = await sqliteSnapshot(this.dataDir)
    assert.equal(disk.integrity, 'ok')
    assert.deepEqual(disk.foreignKeys, [])
    await this.guardExternalRoot(disk)
    await this.validateDisk(disk)
    const snapshot = (await invoke(this.page, 'load_snapshot')).snapshot
    assert.equal(snapshot.meta.databaseId, disk.meta.databaseId)
    assert.equal(snapshot.events.length, disk.events.length)
    return snapshot
  }

  async waitApp() {
    await this.page.getByRole('button', { name: '打开人生目录', exact: true }).waitFor({ state: 'visible', timeout: 25_000 })
    await this.page.locator('.lt-seasonal-splash').waitFor({ state: 'hidden', timeout: 10_000 })
  }

  async start() {
    await this.guardExternalRoot()
    if (this.externalFixtureRoot && await fs.stat(path.join(this.dataDir, 'life-timeline.sqlite')).then(() => true, (error) => error.code === 'ENOENT' ? false : Promise.reject(error))) {
      await this.guardExternalRoot(await sqliteSnapshot(this.dataDir))
    }
    await noRedirect(this.exe)
    assert(below(path.join(this.root, 'artifacts'), this.exe), 'Native fixture EXE must be under project artifacts')
    await this.portFree()
    this.child = spawn(this.exe, [], { cwd: path.dirname(this.exe), windowsHide: true, stdio: 'ignore', env: {
      ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${this.port} --remote-debugging-address=127.0.0.1`,
    } })
    const endpoint = `http://127.0.0.1:${this.port}`
    await until(async () => {
      assert.equal(this.child.exitCode, null, 'Isolated app exited during startup')
      try { return (await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1000) })).ok } catch { return false }
    }, 'Isolated WebView2 startup timed out', 45_000)
    await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `
$ErrorActionPreference='Stop'
$p=Get-Process -Id ([int]$env:LT_FIXTURE_PID)
if (-not ([IO.Path]::GetFullPath($p.Path)).Equals([IO.Path]::GetFullPath($env:LT_FIXTURE_EXE),[StringComparison]::OrdinalIgnoreCase)) {throw 'Wrong isolated process'}
$listeners=@(Get-NetTCPConnection -LocalPort ([int]$env:LT_FIXTURE_PORT) -State Listen)
if ($listeners.Count -eq 0) {throw 'No CDP listener'}
foreach ($listener in $listeners) {
 $candidate=[int]$listener.OwningProcess; $owned=$false
 for ($i=0;$i -lt 16 -and $candidate -gt 0;$i++) {
  if ($candidate -eq $p.Id) {$owned=$true;break}
  $entry=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$candidate)
  if (-not $entry) {break}; $candidate=[int]$entry.ParentProcessId
 }
 if (-not $owned) {throw 'CDP is not owned by the isolated process'}
}
`], { env: { ...process.env, LT_FIXTURE_PID: String(this.child.pid), LT_FIXTURE_EXE: this.exe, LT_FIXTURE_PORT: String(this.port) } })
    this.browser = await this.chromium.connectOverCDP(endpoint)
    await until(() => {
      this.page = this.browser.contexts().flatMap((context) => context.pages()).find((page) => /^(https?:\/\/tauri\.localhost(?:[/:]|$)|tauri:)/i.test(page.url()))
      return Boolean(this.page)
    }, 'No isolated Tauri page')
    this.page.setDefaultTimeout(12_000)
    this.page.on('pageerror', (error) => this.errors.push(error.message))
    this.page.on('console', (message) => { if (message.type() === 'error') this.errors.push(message.text()) })
    await this.page.exposeFunction('__nativeFixtureObserved', (item) => this.observed.push(item))
    await this.page.waitForFunction(() => Boolean(window.__TAURI_INTERNALS__?.invoke))
    await this.guard()
    await this.waitApp()
    return this.page
  }

  async pickers({ open = [], save = [] } = {}) {
    await this.page.evaluate(({ open, save }) => {
      if (!window.__nativeFixturePicker) {
        const original = window.fetch.bind(window)
        window.__nativeFixturePicker = { open: [], save: [] }
        window.fetch = async (input, options) => {
          const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
          const url = new URL(raw, window.location.href)
          const command = url.hostname === 'ipc.localhost' || url.protocol === 'ipc:' ? decodeURIComponent(url.pathname).replace(/^\/+/, '') : null
          if (command === 'plugin:dialog|open' || command === 'plugin:dialog|save') {
            const queue = window.__nativeFixturePicker[command.endsWith('|open') ? 'open' : 'save']
            if (!queue.length) throw new Error('Unexpected native picker; no response queued')
            return new Response(JSON.stringify(queue.shift()), { headers: { 'Tauri-Response': 'ok', 'Content-Type': 'application/json' } })
          }
          const response = await original(input, options)
          if (command && /^(ai_import_|api_|diary_)/.test(command)) {
            const success = response.headers.get('Tauri-Response') === 'ok'
            // Test fixtures only. API save payload, request headers, runtime
            // invoke keys and raw provider errors are never inspected.
            const result = await response.clone().json().catch(() => null)
            await window.__nativeFixtureObserved({ command, success, result: success ? result : { code: result?.code ?? null } })
          }
          return response
        }
      }
      window.__nativeFixturePicker.open.push(...open)
      window.__nativeFixturePicker.save.push(...save)
    }, { open, save })
  }

  async close() {
    if (!this.child) return
    const child = this.child
    if (child.exitCode === null) {
      await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `
$ErrorActionPreference='Stop'
$p=Get-Process -Id ([int]$env:LT_FIXTURE_PID)
if (-not ([IO.Path]::GetFullPath($p.Path)).Equals([IO.Path]::GetFullPath($env:LT_FIXTURE_EXE),[StringComparison]::OrdinalIgnoreCase)) {throw 'Wrong isolated process; refusing close'}
if (-not $p.CloseMainWindow()) {throw 'No closable isolated main window'}
`], { env: { ...process.env, LT_FIXTURE_PID: String(child.pid), LT_FIXTURE_EXE: this.exe } })
      await until(() => child.exitCode !== null, 'Normal close did not complete; isolated process was not force-killed', 25_000)
    }
    this.report.tests.push({ name: 'isolated-app-normal-close', status: 'PASS', pid: child.pid, exitCode: child.exitCode })
    this.child = null
    this.page = null
    await this.browser?.close().catch(() => undefined)
    this.browser = null
    await until(async () => { try { await this.portFree(); return true } catch { return false } }, 'Owned CDP port did not close')
  }
}

export async function openOperation(page, name) {
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
  await page.getByRole('button', { name: '添加与日记管理', exact: true }).click()
  await page.getByRole('dialog', { name: '记录操作', exact: true }).getByRole('menuitem', { name, exact: true }).click()
  const dialog = page.getByRole('dialog', { name, exact: true })
  await dialog.waitFor({ state: 'visible' })
  return dialog
}

export async function closeOperation(page, name) {
  const dialog = page.getByRole('dialog', { name, exact: true })
  await dialog.getByRole('button', { name: '返回人生时间轴', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
}
