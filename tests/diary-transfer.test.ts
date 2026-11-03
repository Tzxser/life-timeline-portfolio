import assert from 'node:assert/strict'
import test from 'node:test'
import { configureDesktopInvoker } from '../lib/desktop-commands'
import { exportDiaries, importDiaries, scanDiaries, waitForDiaryTransfers } from '../lib/diary-transfer'

test('diary export rejects incomplete, inverted and impossible date ranges before invoking storage', () => {
  let nativeCalls = 0
  configureDesktopInvoker(async <T>() => { nativeCalls += 1; return {} as T })
  try {
    for (const [startDate, endDate] of [
      ['2026-10-01', null], [null, '2026-10-01'],
      ['2026-10-02', '2026-10-01'], ['2026-02-29', '2026-03-01'],
      ['2026-04-31', '2026-05-01'], ['0000-01-01', '2026-01-01'],
    ]) assert.throws(() => exportDiaries({ destinationPath: 'D:/合成数据/日记.zip', startDate, endDate }), /日期/)
    assert.equal(nativeCalls, 0)
  } finally { configureDesktopInvoker(null) }
})

test('diary import requires an explicit valid scan and one decision per date', () => {
  const base = { archivePath: 'D:/合成数据/日记.zip', scanToken: 'test-scan' }
  assert.throws(() => importDiaries({ ...base, scanToken: '', decisions: [] }), /扫描/)
  assert.throws(() => importDiaries({ ...base, decisions: [{ date: '2026-02-30', action: 'replace' }] }), /处理选项/)
  assert.throws(() => importDiaries({ ...base, decisions: [{ date: '2026-10-01', action: 'delete' as never }] }), /处理选项/)
  assert.throws(() => importDiaries({ ...base, decisions: [{ date: '2026-10-01', action: 'merge' }, { date: '2026-10-01', action: 'replace' }] }), /处理选项/)
  assert.throws(() => scanDiaries({ archivePath: 'bad\0.zip' }), /文件路径/)
})

test('transfer IPC carries exact selected paths and explicit conflict actions without a restore command', async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = []
  configureDesktopInvoker(async <T>(command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args })
    return { revision: 2 } as T
  })
  try {
    await exportDiaries({ destinationPath: 'D:/合成数据/全部.zip' })
    await exportDiaries({ destinationPath: 'D:/合成数据/闰日.zip', startDate: '2024-02-29', endDate: '2024-02-29', overwrite: true })
    await scanDiaries({ archivePath: 'D:/合成数据/全部.zip' })
    const decisions = [{ date: '2026-10-01', action: 'merge' as const }]
    await importDiaries({ archivePath: 'D:/合成数据/全部.zip', scanToken: 'opaque-scan', decisions })
    assert.deepEqual(calls.map((call) => call.command), ['diary_export', 'diary_export', 'diary_scan', 'diary_import'])
    assert.deepEqual(calls[0].args, { request: { destinationPath: 'D:/合成数据/全部.zip', startDate: null, endDate: null } })
    assert.deepEqual(calls[3].args, { request: { archivePath: 'D:/合成数据/全部.zip', scanToken: 'opaque-scan', decisions } })
  } finally { configureDesktopInvoker(null) }
})

test('the close barrier waits for every pending transfer, including a failing operation', async () => {
  let finishExport!: (value: unknown) => void
  let failScan!: (error: unknown) => void
  configureDesktopInvoker(<T>(command: string) => new Promise<T>((resolve, reject) => {
    if (command === 'diary_export') finishExport = (value) => resolve(value as T)
    else failScan = reject
  }))
  try {
    const exporting = exportDiaries({ destinationPath: 'D:/test-only.zip' })
    const scanning = assert.rejects(scanDiaries({ archivePath: 'D:/test-only.zip' }), /damaged fixture/)
    let safeToClose = false
    const guard = waitForDiaryTransfers().then(() => { safeToClose = true })
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(safeToClose, false)
    finishExport({ diaryCount: 1 })
    await exporting
    assert.equal(safeToClose, false)
    failScan({ message: 'damaged fixture' })
    await scanning
    await guard
    assert.equal(safeToClose, true)
  } finally { configureDesktopInvoker(null) }
})
