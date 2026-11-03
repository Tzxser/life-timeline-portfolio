#!/usr/bin/env node

/**
 * Browser-only acceptance for the static export.
 *
 * This deliberately runs against the local static preview and an isolated
 * Chromium profile. It does not exercise Tauri IPC, SQLite or native dialogs;
 * those gates belong to the native acceptance harness.
 */
import { createRequire } from 'node:module'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openCreateEventDrawer } from './ui-actions.mjs'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const ARTIFACT_DIR = path.join(ROOT, 'artifacts', `web-acceptance-${new Date().toISOString().replaceAll(/[:.]/g, '-')}`)
const BASE_URL = process.env.WEB_ACCEPTANCE_URL ?? 'http://127.0.0.1:4173/'
const PLAYWRIGHT = process.env.LIFE_TIMELINE_PLAYWRIGHT_MODULE
  ?? path.join(process.env.USERPROFILE ?? '', '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'node_modules', 'playwright')
const CHROMIUM = process.env.WEB_ACCEPTANCE_CHROMIUM
  ?? 'C:/Users/example-user/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe'
const require = createRequire(import.meta.url)
const { chromium } = require(PLAYWRIGHT)

await fs.mkdir(ARTIFACT_DIR, { recursive: true })
const report = {
  startedAt: new Date().toISOString(),
  baseUrl: BASE_URL,
  mode: 'browser-static-preview',
  native: false,
  tests: [],
  screenshots: [],
  status: 'running',
}

function pass(name, details = {}) {
  report.tests.push({ name, status: 'PASS', ...details })
}

async function screenshot(page, name) {
  const target = path.join(ARTIFACT_DIR, `${name}.png`)
  await page.screenshot({ path: target, fullPage: true })
  report.screenshots.push(target)
  return target
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const browser = await chromium.launch({
  headless: true,
  executablePath: CHROMIUM,
  args: ['--disable-background-networking', '--disable-component-update'],
})
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  colorScheme: 'light',
})
const page = await context.newPage()
page.on('console', (message) => {
  if (message.type() === 'error') report.consoleErrors = [...(report.consoleErrors ?? []), message.text()]
})
page.on('pageerror', (error) => {
  report.pageErrors = [...(report.pageErrors ?? []), error.message]
})

try {
  const response = await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  assert(response?.ok(), `Static preview returned ${response?.status() ?? 'no response'}`)
  const splash = page.locator('.lt-seasonal-splash')
  await page.waitForFunction(() => document.querySelector('.lt-seasonal-splash')?.getAttribute('data-phase') === 'visible', undefined, { timeout: 2_000 })
  const splashSeason = await splash.getAttribute('data-season')
  assert(['spring', 'summer', 'autumn', 'winter'].includes(splashSeason ?? ''), `Unexpected seasonal splash: ${splashSeason}`)
  await screenshot(page, 'seasonal-splash')
  await page.waitForTimeout(1_800)
  assert(await splash.count() === 0, 'Seasonal splash did not finish within the startup budget')
  pass('seasonal-startup-splash', { season: splashSeason, maxVisibleMs: 1_800 })
  await page.waitForLoadState('networkidle')
  await page.getByText('LIFE', { exact: true }).first().waitFor({ state: 'visible', timeout: 15_000 })
  await page.waitForTimeout(250)
  pass('cold-start-static-page', { status: response.status(), title: await page.title() })
  await screenshot(page, 'start')

  const iconResponse = await context.request.get(new URL('/life-timeline-icon-256.png', BASE_URL).toString())
  assert(iconResponse.ok() && iconResponse.headers()['content-type']?.startsWith('image/png'), 'Custom favicon PNG was not served')
  const iconLink = await page.locator('link[rel="icon"]').getAttribute('href')
  assert(iconLink?.includes('life-timeline-icon-32.png'), `Unexpected favicon href: ${iconLink}`)
  pass('custom-favicon', { href: iconLink, status: iconResponse.status() })

  const themeButton = page.getByRole('button', { name: /当前.+模式,点击切换/ }).first()
  const beforeTheme = await themeButton.getAttribute('aria-label')
  await themeButton.click()
  await page.waitForTimeout(100)
  const afterTheme = await page.getByRole('button', { name: /当前.+模式,点击切换/ }).first().getAttribute('aria-label')
  assert(beforeTheme && afterTheme && beforeTheme !== afterTheme, 'Theme toggle did not change its visible state')
  pass('theme-cycle', { before: beforeTheme, after: afterTheme, htmlClass: await page.locator('html').getAttribute('class') })
  await screenshot(page, 'theme-toggled')

  const directoryButton = page.getByRole('button', { name: '打开人生目录' })
  await directoryButton.click()
  const directory = page.getByRole('dialog', { name: '人生目录' })
  await directory.waitFor({ state: 'visible' })
  const directoryCount = await directory.getByText('全部记忆', { exact: false }).first().textContent()
  await directory.getByRole('textbox', { name: '搜索人生记录' }).fill('第一次上学')
  await directory.getByRole('button', { name: /第一次上学/ }).waitFor({ state: 'visible' })
  pass('directory-search', { summary: directoryCount?.trim() ?? null })
  await directory.getByRole('button', { name: '关闭目录' }).click()

  await page.getByRole('button', { name: '搜索' }).click()
  const search = page.getByRole('dialog', { name: '搜索人生记录' })
  await search.getByRole('textbox', { name: '搜索你的人生' }).fill('自行车')
  await search.getByRole('option').first().waitFor({ state: 'visible' })
  const searchResult = await search.getByRole('option').first().textContent()
  pass('global-search', { result: searchResult?.trim() ?? null })
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: '时间轴显示设置' }).click()
  const settings = page.getByRole('dialog', { name: '时间轴显示设置' })
  await settings.waitFor({ state: 'visible' })
  const slider = settings.locator('input[type="range"]').first()
  const beforeSlider = await slider.inputValue()
  await slider.evaluate((input) => {
    const value = Number(input.value)
    const min = Number(input.min)
    const max = Number(input.max)
    const next = value >= max ? min : Math.min(max, value + (max - min) / 4)
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, String(next))
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await page.waitForTimeout(150)
  const afterSlider = await slider.inputValue()
  assert(beforeSlider !== afterSlider, 'Timeline settings slider did not update')
  await settings.getByRole('button', { name: '恢复默认' }).click()
  await settings.getByRole('status').waitFor({ state: 'visible' })
  await settings.getByRole('button', { name: '撤销' }).click()
  pass('timeline-settings-preview-and-undo', { beforeSlider, afterSlider })

  const startupSplashToggle = settings.getByRole('checkbox', { name: '显示四季启动画面' })
  assert(await startupSplashToggle.isChecked(), 'Seasonal splash should be enabled by default')
  await startupSplashToggle.uncheck()
  assert(!(await startupSplashToggle.isChecked()), 'Seasonal splash setting did not turn off')
  await startupSplashToggle.check()

  const automation = settings.getByRole('region', { name: '自动调色' })
  await automation.waitFor({ state: 'visible' })
  const automationToggle = automation.getByRole('checkbox', { name: '自动调色' })
  assert(await automationToggle.isChecked(), 'Automatic theme should be enabled by default')
  assert(await automation.locator('input[type="time"]').count() === 2, 'Automatic theme time controls are missing')
  const eyeCareToggle = automation.getByRole('checkbox', { name: '连续使用后自动护眼' })
  assert(await eyeCareToggle.isChecked(), 'Eye-care automation should be enabled by default')
  pass('theme-automation-settings', { dayNightTimeInputs: 2, eyeCareDefault: true })
  await settings.getByRole('button', { name: '完成' }).click()

  await openCreateEventDrawer(page)
  const create = page.getByRole('dialog', { name: '新建人生节点' })
  await create.getByLabel('发生了什么?').fill('浏览器验收临时节点')
  await create.getByLabel('想先写几句吗?(可选)').fill('此节点只存在于独立浏览器内存会话。')
  await create.getByRole('button', { name: '创建节点' }).click()
  // EventWritingPane intentionally assigns role="button" to its editable h1;
  // query the concrete heading element rather than relying on its overridden
  // accessibility role.
  await page.locator('h1').filter({ hasText: '浏览器验收临时节点' }).waitFor({ state: 'visible' })
  pass('create-event-browser-memory', { note: 'BrowserLifePlatform only; no disk persistence claim' })
  await screenshot(page, 'event-created')

  await page.getByRole('button', { name: '图集' }).click()
  const gallery = page.getByRole('dialog', { name: '图集' })
  await gallery.waitFor({ state: 'visible' })
  const galleryText = await gallery.textContent()
  assert(galleryText?.includes('还没有收录'), 'Gallery empty state was not rendered')
  pass('gallery-empty-state', { text: '还没有收录' })
  await gallery.getByRole('button', { name: '返回人生时间轴' }).click()

  // The browser adapter intentionally has no file picker or native backup
  // transport. The rich editor still exposes the same insertion affordances,
  // while local-data controls explain that the desktop build supplies them.
  const toolbar = page.getByRole('toolbar', { name: '正文工具' })
  assert(await toolbar.getByRole('button', { name: '插入图片' }).count() === 1, 'Image insertion control is missing')
  assert(await toolbar.getByRole('button', { name: '添加附件' }).count() === 1, 'Attachment insertion control is missing')
  pass('editor-attachment-controls-visible', { note: 'Browser file import is intentionally not executed' })

  await page.getByRole('button', { name: '时间轴显示设置' }).click()
  const localData = page.getByRole('region', { name: '本地数据' })
  const localDataText = await localData.textContent()
  assert(localDataText?.includes('静态预览不会读写本机资料库'), 'Static-preview local-data boundary is missing')
  pass('backup-controls-browser-boundary', { note: 'Browser preview explains that export/restore are supplied by the desktop runtime' })
  await screenshot(page, 'settings-local-data')
  await page.getByRole('button', { name: '完成' }).click()

  for (const viewport of [
    { width: 1320, height: 823 },
    { width: 1440, height: 900 },
    { width: 1280, height: 720 },
  ]) {
    const responsiveContext = await browser.newContext({ viewport, deviceScaleFactor: 1, colorScheme: 'light' })
    const responsivePage = await responsiveContext.newPage()
    const responsiveResponse = await responsivePage.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await responsivePage.getByText('LIFE', { exact: true }).first().waitFor({ state: 'visible', timeout: 15_000 })
    const overflow = await responsivePage.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: window.innerWidth }))
    assert(overflow.width <= overflow.viewport + 1, `Horizontal overflow at ${viewport.width}px: ${JSON.stringify(overflow)}`)
    pass(`responsive-${viewport.width}x${viewport.height}`, { status: responsiveResponse?.status(), overflow })
    await responsiveContext.close()
  }

  const reducedContext = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
    reducedMotion: 'reduce',
  })
  const reducedPage = await reducedContext.newPage()
  await reducedPage.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await reducedPage.getByText('LIFE', { exact: true }).first().waitFor({ state: 'visible', timeout: 15_000 })
  const reducedMotion = await reducedPage.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
  assert(reducedMotion, 'Reduced-motion media preference was not exposed to the page')
  pass('reduced-motion-startup', { prefersReducedMotion: reducedMotion })
  await reducedContext.close()

  assert((report.consoleErrors ?? []).length === 0, `Console errors: ${(report.consoleErrors ?? []).join(' | ')}`)
  assert((report.pageErrors ?? []).length === 0, `Page errors: ${(report.pageErrors ?? []).join(' | ')}`)
  report.status = 'PASS'
} catch (error) {
  report.status = 'FAIL'
  report.error = error instanceof Error ? error.stack ?? error.message : String(error)
  await screenshot(page, 'failure').catch(() => undefined)
  process.exitCode = 1
} finally {
  report.finishedAt = new Date().toISOString()
  await fs.writeFile(path.join(ARTIFACT_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  await browser.close()
  console.log(JSON.stringify(report, null, 2))
}
