#!/usr/bin/env node

/**
 * Native acceptance harness for life-timeline.
 *
 * This is deliberately separate from the browser contract tests. It connects
 * to a real Tauri/WebView2 page over loopback CDP and calls the injected Tauri
 * IPC bridge; no mocked invoke function or HTTP preview is accepted.
 *
 * Example (PowerShell):
 *   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9223 --remote-debugging-address=127.0.0.1'
 *   node scripts/e2e-native-acceptance.mjs --exe .\src-tauri\target\release\life-timeline.exe
 *
 * The executable must have been built with a dedicated Tauri config, for
 * example `{ "app": { "appDirectoriesOverride": "D:/life-timeline/test-data/native-acceptance" } }`.
 * The harness refuses to delete or use a data directory unless its final
 * directory name is `native-acceptance`, unless --allow-data-dir is supplied.
 */

import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'
import { openCreateEventDrawer } from './ui-actions.mjs'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const DEFAULT_DATA_DIR = path.join(ROOT, 'test-data', 'native-acceptance')
const DEFAULT_CDP_PORT = 9223

function option(name, fallback = undefined) {
  const args = process.argv.slice(2)
  const index = args.indexOf(name)
  if (index < 0) return fallback
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

function hasFlag(name) {
  return process.argv.slice(2).includes(name)
}

function usage() {
  return [
    'Usage: node scripts/e2e-native-acceptance.mjs --exe <life-timeline.exe> [options]',
    '',
    'Options:',
    '  --exe <path>             Real Tauri executable to launch.',
    '  --cdp-port <port>        WebView2 CDP port (default 9223).',
    `  --data-dir <path>        Dedicated data root (default ${DEFAULT_DATA_DIR}).`,
    '  --artifact-dir <path>    Output directory for native screenshots/report.',
    '  --attach                 Attach to an already running process; do not launch.',
    '  --keep-data              Do not clear the dedicated test data directory first.',
    '  --allow-data-dir         Allow a data directory whose final name is not native-acceptance.',
    '  --no-close-test          Do not exercise the native close request at the end.',
  ].join('\n')
}

if (hasFlag('--help') || hasFlag('-h')) {
  console.log(usage())
  process.exit(0)
}

const executable = option('--exe')
const cdpPort = Number(option('--cdp-port', String(DEFAULT_CDP_PORT)))
const dataDir = path.resolve(option('--data-dir', DEFAULT_DATA_DIR))
const artifactDir = path.resolve(
  option('--artifact-dir', path.join(ROOT, 'artifacts', `native-acceptance-${new Date().toISOString().replaceAll(/[:.]/g, '-')}`)),
)
const attach = hasFlag('--attach')
const keepData = hasFlag('--keep-data')
const closeTest = !hasFlag('--no-close-test')

if (!Number.isInteger(cdpPort) || cdpPort < 1024 || cdpPort > 65535) {
  throw new Error(`Invalid CDP port: ${cdpPort}`)
}
if (!attach && !executable) {
  console.error(usage())
  process.exitCode = 2
  throw new Error('No executable was supplied; native acceptance was not run.')
}
if (!hasFlag('--allow-data-dir') && path.basename(dataDir).toLowerCase() !== 'native-acceptance') {
  throw new Error(`Refusing non-dedicated data directory: ${dataDir}. Use --allow-data-dir only for a deliberate isolated fixture.`)
}

await fs.mkdir(artifactDir, { recursive: true })
if (!keepData) {
  await fs.rm(dataDir, { recursive: true, force: true })
}
await fs.mkdir(dataDir, { recursive: true })

function resolvePlaywright() {
  const candidates = [
    process.env.LIFE_TIMELINE_PLAYWRIGHT_MODULE,
    path.join(ROOT, 'node_modules', 'playwright'),
    path.join(process.env.USERPROFILE ?? '', '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'node_modules', 'playwright'),
  ].filter(Boolean)
  for (const candidate of candidates) {
    try {
      const require = createRequire(import.meta.url)
      return require(candidate)
    } catch {
      // Try the next installation; the repository intentionally has no test-only dependency.
    }
  }
  throw new Error('Playwright is unavailable. Set LIFE_TIMELINE_PLAYWRIGHT_MODULE to an installed Playwright package; no native test was run.')
}

const { chromium } = resolvePlaywright()

async function waitForCdp(port, timeoutMs = 45_000) {
  const endpoint = `http://127.0.0.1:${port}`
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint}/json/version`)
      if (response.ok) {
        const version = await response.json()
        if (typeof version.webSocketDebuggerUrl === 'string') return { endpoint, version }
      }
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`WebView2 CDP did not become ready at ${endpoint}: ${lastError instanceof Error ? lastError.message : 'timeout'}`)
}

function isTauriPage(page) {
  const url = page.url()
  return /^(asset|tauri|https?):/i.test(url) && !/devtools|chrome-extension/i.test(url)
}

async function selectPage(browser, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let pages = []
  while (Date.now() < deadline) {
    pages = browser.contexts().flatMap((context) => context.pages()).filter(isTauriPage)
    if (pages.length > 0) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  if (pages.length === 0) throw new Error('CDP connected but no application WebView page was found.')
  const page = pages.find((item) => /(?:tauri\.localhost|asset\.localhost|tauri:)/i.test(item.url())) ?? pages[0]
  await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => undefined)
  return page
}

async function nativeInvoke(page, command, args = undefined) {
  return page.evaluate(
    async ({ command: name, args: payload }) => {
      const bridge = globalThis.__TAURI_INTERNALS__?.invoke
      if (typeof bridge !== 'function') {
        throw new Error('The page did not expose __TAURI_INTERNALS__.invoke; this is not a native Tauri test.')
      }
      return await bridge(name, payload)
    },
    { command, args },
  )
}

async function sha256(filePath) {
  const hash = createHash('sha256')
  hash.update(await fs.readFile(filePath))
  return hash.digest('hex')
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function resolveAttachmentPath(relativePath) {
  assert(typeof relativePath === 'string' && relativePath.startsWith('attachments/'), `Unexpected attachment path: ${relativePath}`)
  const resolved = path.resolve(dataDir, relativePath.replaceAll('/', path.sep))
  const attachmentRoot = path.resolve(dataDir, 'attachments') + path.sep
  assert(resolved.startsWith(attachmentRoot), `Attachment path escaped the dedicated data root: ${resolved}`)
  return resolved
}

async function screenshot(page, name) {
  const target = path.join(artifactDir, `${name}.png`)
  await page.screenshot({ path: target, fullPage: true })
  return target
}

async function createNativeEventThroughUi(page) {
  await openCreateEventDrawer(page)
  await page.locator('#create-title').fill('原生验收记录')
  await page.locator('#create-content').fill('这条记录由真实 Tauri 窗口验收脚本创建。')
  await page.getByRole('button', { name: '创建节点' }).click()
  await page.getByRole('button', { name: '原生验收记录', exact: true }).waitFor({ state: 'visible', timeout: 15_000 })
}

async function sendNativeClose(processId) {
  // WM_CLOSE exercises Tauri's on_window_event close guard. The native app
  // prevents the first request, emits close-requested to the renderer, and
  // only exits after the renderer flushes and invokes confirm_close.
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class LifeTimelineClose {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  public static bool CloseProcessWindow(uint pid) {
    bool sent = false;
    EnumWindows((hWnd, lParam) => {
      uint actual; GetWindowThreadProcessId(hWnd, out actual);
      if (actual == pid && IsWindowVisible(hWnd)) { SendMessage(hWnd, 0x0010, IntPtr.Zero, IntPtr.Zero); sent = true; return false; }
      return true;
    }, IntPtr.Zero);
    return sent;
  }
}
'@
if (-not [LifeTimelineClose]::CloseProcessWindow(${processId})) { throw 'No visible life-timeline window was found' }
`
  await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', reject)
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(stderr || `WM_CLOSE helper exited ${code}`)))
  })
}

const report = {
  startedAt: new Date().toISOString(),
  executable: executable ? path.resolve(executable) : null,
  cdpPort,
  dataDir,
  artifactDir,
  tests: [],
  screenshots: [],
  status: 'running',
}
let child = null
let browser = null

function record(name, details = {}) {
  report.tests.push({ name, status: 'PASS', ...details })
}

try {
  if (!attach) {
    const exePath = path.resolve(executable)
    const stat = await fs.stat(exePath).catch(() => null)
    assert(stat?.isFile(), `Executable does not exist: ${exePath}`)
    assert(exePath.toLowerCase().endsWith('.exe'), `--exe must point to a Windows executable: ${exePath}`)
    const launchEnv = {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort} --remote-debugging-address=127.0.0.1`,
      LIFE_TIMELINE_NATIVE_ACCEPTANCE: '1',
    }
    child = spawn(exePath, [], { cwd: path.dirname(exePath), env: launchEnv, windowsHide: false, stdio: 'ignore' })
    child.on('error', (error) => { report.launchError = error.message })
  }

  const cdp = await waitForCdp(cdpPort)
  browser = await chromium.connectOverCDP(cdp.endpoint)
  const page = await selectPage(browser)
  report.pageUrl = page.url()
  assert(/(?:tauri\.localhost|asset\.localhost|tauri:)/i.test(page.url()), `Unexpected page URL for native acceptance: ${page.url()}`)
  await page.waitForTimeout(500)
  await page.screenshot({ path: path.join(artifactDir, 'native-start.png'), fullPage: true })
  report.screenshots.push(path.join(artifactDir, 'native-start.png'))
  const title = await page.title()
  assert(title.includes('Life Timeline'), `Unexpected native window document title: ${title}`)
  const bridge = await page.evaluate(() => typeof globalThis.__TAURI_INTERNALS__?.invoke === 'function')
  assert(bridge, 'Tauri IPC bridge is not present in the real WebView')
  record('native-webview-and-ipc', { title, url: page.url() })

  const loadedBefore = await nativeInvoke(page, 'load_snapshot')
  assert(loadedBefore && loadedBefore.snapshot && Array.isArray(loadedBefore.snapshot.events), 'load_snapshot did not return a typed snapshot')
  record('load-empty-dedicated-database', { initialEvents: loadedBefore.snapshot.events.length })

  await createNativeEventThroughUi(page)
  record('create-event-through-ui')
  report.screenshots.push(await screenshot(page, 'native-event-created'))
  // The renderer's revisioned queue is intentionally debounced while typing;
  // give its normal save path time to issue the real IPC before inspecting the
  // SQLite snapshot below.
  await page.waitForTimeout(1_500)

  const afterUi = await nativeInvoke(page, 'load_snapshot')
  const uiEvent = afterUi.snapshot.events.find((event) => event.title === '原生验收记录')
  assert(uiEvent, 'The event created through the UI was not persisted by the native store')

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
  const imported = await nativeInvoke(page, 'import_attachment', {
    request: {
      name: 'native-acceptance.png',
      mimeType: 'image/png',
      kind: 'image',
      width: 1,
      height: 1,
      lastModified: 0,
      bytes: [...png],
    },
  })
  const attachment = imported?.meta ?? imported
  assert(typeof attachment?.id === 'string', 'import_attachment returned no attachment id')
  assert(typeof imported?.relativePath === 'string', 'import_attachment returned no controlled relative path')
  const attachmentPath = resolveAttachmentPath(imported.relativePath)
  const attachmentStat = await fs.stat(attachmentPath)
  assert(attachmentStat.isFile(), `Attachment was not written as a file: ${attachmentPath}`)
  assert(attachmentStat.size === png.length, 'Attachment byte size on disk does not match import bytes')
  assert((await sha256(attachmentPath)) === String(attachment.sha256).toLowerCase(), 'Attachment SHA-256 does not match native metadata')
  const resolved = await nativeInvoke(page, 'attachment_path', { request: { id: attachment.id } })
  assert(typeof resolved?.assetUrl === 'string' && /^https?:\/\/asset\.localhost\//.test(resolved.assetUrl), 'attachment_path did not return a scoped asset URL')
  record('attachment-import-and-disk-hash', { id: attachment.id, relativePath: imported.relativePath, bytes: png.length })

  const richContent = {
    version: 1,
    format: 'tiptap-json',
    doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '带附件的原生验收记录' }] }, { type: 'lifeImage', attrs: { attachmentId: attachment.id, alt: 'native acceptance' } }] },
  }
  const snapshotWithAttachment = {
    ...afterUi.snapshot,
    events: afterUi.snapshot.events.map((event) => event.id === uiEvent.id
      ? { ...event, content: '这条记录由真实 Tauri 窗口验收脚本创建。', richContent, attachmentIds: [attachment.id] }
      : event),
    revision: Math.max(afterUi.revision ?? afterUi.snapshot.revision ?? 0, 1) + 1,
  }
  await nativeInvoke(page, 'save_snapshot', { snapshot: snapshotWithAttachment, revision: snapshotWithAttachment.revision })
  await nativeInvoke(page, 'flush_persistence')
  record('save-rich-content-and-attachment-reference')

  const backupPath = path.join(dataDir, 'backups', 'native-acceptance.zip')
  await fs.rm(backupPath, { force: true })
  const exported = await nativeInvoke(page, 'backup_export', { request: { destinationPath: backupPath, overwrite: true } })
  assert(await fs.stat(backupPath).then((item) => item.isFile()), 'backup_export did not create a ZIP file')
  record('backup-export', { archivePath: exported?.archivePath ?? backupPath, bytes: exported?.byteSize })
  const scan = await nativeInvoke(page, 'backup_scan', { request: { archivePath: backupPath } })
  assert(scan?.canRestore === true && scan?.counts?.attachments >= 1, 'backup_scan did not validate the attachment-bearing archive')
  record('backup-scan', { counts: scan.counts, sha256: scan.archiveSha256 })

  const changed = {
    ...snapshotWithAttachment,
    events: snapshotWithAttachment.events.map((event) => event.id === uiEvent.id ? { ...event, title: '应被恢复覆盖的临时标题' } : event),
    revision: snapshotWithAttachment.revision + 1,
  }
  await nativeInvoke(page, 'save_snapshot', { snapshot: changed, revision: changed.revision })
  await nativeInvoke(page, 'flush_persistence')
  const restored = await nativeInvoke(page, 'backup_restore', { request: { archivePath: backupPath, scanToken: scan.scanToken, confirmation: 'replace-current' } })
  assert(typeof restored?.previousLibraryBackupPath === 'string', 'backup_restore did not return the pre-restore backup path')
  const afterRestore = await nativeInvoke(page, 'load_snapshot')
  const restoredEvent = afterRestore.snapshot.events.find((event) => event.id === uiEvent.id)
  assert(restoredEvent?.title === '原生验收记录', 'backup_restore did not restore the original event')
  assert(restoredEvent?.attachmentIds?.includes(attachment.id), 'backup_restore lost the attachment reference')
  record('backup-restore-replaces-current-library', { counts: restored.counts, previousLibraryBackupPath: restored.previousLibraryBackupPath })
  report.screenshots.push(await screenshot(page, 'native-after-restore'))

  const status = await nativeInvoke(page, 'backup_status')
  assert(['running', 'success', 'error'].includes(status?.status), 'backup_status returned an invalid status')
  record('automatic-backup-status', { status: status.status, lastSuccessAt: status.lastSuccessAt ?? null })

  await nativeInvoke(page, 'flush_persistence')
  record('flush-before-restart')
  const oldPid = child?.pid
  if (!attach && child && oldPid) {
    child.kill()
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    child = null
    await browser.close().catch(() => undefined)
    browser = null
    const restarted = spawn(path.resolve(executable), [], {
      cwd: path.dirname(path.resolve(executable)),
      env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort} --remote-debugging-address=127.0.0.1`, LIFE_TIMELINE_NATIVE_ACCEPTANCE: '1' },
      windowsHide: false,
      stdio: 'ignore',
    })
    child = restarted
    const restartCdp = await waitForCdp(cdpPort)
    browser = await chromium.connectOverCDP(restartCdp.endpoint)
    const restartedPage = await selectPage(browser)
    const afterRestart = await nativeInvoke(restartedPage, 'load_snapshot')
    const restartedEvent = afterRestart.snapshot.events.find((event) => event.id === uiEvent.id)
    assert(restartedEvent?.title === '原生验收记录', 'SQLite data did not survive a real process restart')
    assert(restartedEvent?.attachmentIds?.includes(attachment.id), 'Attachment reference did not survive a real process restart')
    record('sqlite-and-attachment-survive-restart', { pidBefore: oldPid, pidAfter: restarted.pid })
  }

  if (closeTest && !attach && child?.pid) {
    await sendNativeClose(child.pid)
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    record('native-close-request-roundtrip')
  }

  report.status = 'PASS'
} catch (error) {
  report.status = 'FAIL'
  report.error = error instanceof Error ? error.stack ?? error.message : String(error)
  process.exitCode = 1
} finally {
  report.finishedAt = new Date().toISOString()
  await fs.writeFile(path.join(artifactDir, 'native-acceptance.json'), JSON.stringify(report, null, 2), 'utf8')
  if (browser) await browser.close().catch(() => undefined)
  if (child && !child.killed) child.kill()
  console.log(JSON.stringify(report, null, 2))
}

