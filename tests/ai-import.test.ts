import assert from 'node:assert/strict'
import test from 'node:test'
import { configureDesktopInvoker } from '../lib/desktop-commands'
import { analyzeAiSources, commitAiImport, rollbackAiImport, waitForAiImports, type ApiProfile } from '../lib/ai-import'

const profile: ApiProfile = { id: 'synthetic-profile', name: '合成接口', baseUrl: 'http://127.0.0.1:45678', model: 'synthetic', hasKey: true, verifiedAt: '2036-01-01T00:00:00Z', supportsImages: true }

test('a read-only model request keeps the confirmed endpoint and cannot trap window close', async () => {
  let finish!: (value: unknown) => void
  let sent: unknown
  configureDesktopInvoker(async <T>(command: string, args?: Record<string, unknown>) => {
    assert.equal(command, 'ai_import_analyze')
    sent = args
    return await new Promise<unknown>((resolve) => { finish = resolve }) as T
  })
  try {
    const analysis = analyzeAiSources('synthetic-session', profile)
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(sent, { request: { sessionId: 'synthetic-session', expectedProfile: profile } })
    await waitForAiImports()
    finish({ entries: [] })
    await analysis
  } finally { configureDesktopInvoker(null) }
})

test('window close waits until AI import has actually finished changing the library', async () => {
  let finish!: (value: unknown) => void
  configureDesktopInvoker(async <T>() => await new Promise<unknown>((resolve) => { finish = resolve }) as T)
  try {
    const commit = commitAiImport('synthetic-session', 'synthetic-scan', [])
    let closed = false
    const closing = waitForAiImports().then(() => { closed = true })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(closed, false)
    finish({ added: 1, undoId: 'synthetic-undo' })
    await commit
    await closing
    assert.equal(closed, true)
  } finally { configureDesktopInvoker(null) }
})

test('a rejected rollback releases its close barrier instead of leaving a stuck window', async () => {
  let fail!: (reason: Error) => void
  configureDesktopInvoker(async <T>() => await new Promise<T>((_resolve, reject) => { fail = reject }))
  try {
    const rollback = rollbackAiImport('synthetic-undo')
    const handled = assert.rejects(rollback)
    const closing = waitForAiImports()
    await new Promise((resolve) => setImmediate(resolve))
    fail(new Error('Synthetic later-edit rejection'))
    await handled
    await closing
  } finally { configureDesktopInvoker(null) }
})
