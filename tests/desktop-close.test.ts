import assert from 'node:assert/strict'
import test from 'node:test'

import { DesktopLifePlatform, isDesktopRuntime } from '../lib/platform/desktop'
import { PersistenceError } from '../lib/platform/contracts'
import { chooseBackupArchive, chooseBackupDestination } from '../lib/native-dialog'
import { chooseDiaryExportPath, chooseDiaryImportPath } from '../lib/diary-transfer'

const CLOSE_EVENT = 'life-timeline://close-requested'
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

/** Exercise the installed Tauri JS APIs, replacing only their native transport. */
function installNativeBridge(options: {
  listenError?: Error
  listenResult?: Promise<number>
  confirmError?: Error
  selectedPath?: string
} = {}) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = []
  const callbacks = new Map<number, (event: unknown) => void | Promise<void>>()
  const removed: Array<{ event: string; eventId: number }> = []
  let closeCallbackId = 0
  let nextCallbackId = 1

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: {
      __TAURI_INTERNALS__: {
        transformCallback(callback: (event: unknown) => void | Promise<void>) {
          const id = nextCallbackId++
          callbacks.set(id, callback)
          return id
        },
        async invoke(command: string, args?: Record<string, unknown>) {
          calls.push({ command, args })
          if (command === 'plugin:event|listen') {
            assert.equal(args?.event, CLOSE_EVENT)
            closeCallbackId = Number(args?.handler)
            if (options.listenError) throw options.listenError
            return options.listenResult ?? 42
          }
          if (command === 'confirm_close' && options.confirmError) throw options.confirmError
          if (command === 'plugin:dialog|save' || command === 'plugin:dialog|open') {
            return options.selectedPath ?? null
          }
          return null
        },
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__: {
        unregisterListener(event: string, eventId: number) {
          removed.push({ event, eventId })
        },
      },
    },
  })

  return {
    calls,
    removed,
    async requestClose() {
      const callback = callbacks.get(closeCallbackId)
      assert.ok(callback, 'the native close listener must be registered')
      await callback({ event: CLOSE_EVENT, id: 42, payload: null })
    },
    restore() {
      if (original) Object.defineProperty(globalThis, 'window', original)
      else Reflect.deleteProperty(globalThis, 'window')
    },
  }
}

test('critical desktop modules can be imported without a browser or native window', () => {
  assert.equal(typeof window, 'undefined')
  assert.equal(isDesktopRuntime(), false)
})

test('failed close-listener registration reports an actionable error instead of silently disabling close', async () => {
  const failure = new Error('synthetic listener failure')
  const bridge = installNativeBridge({ listenError: failure })
  const errors: Error[] = []
  let flushes = 0
  const dispose = new DesktopLifePlatform().registerCloseHandler(async () => { flushes += 1 }, (error) => errors.push(error))
  try {
    await nextTurn()
    assert.equal(errors.length, 1)
    assert.ok(errors[0] instanceof PersistenceError)
    assert.equal(errors[0].code, 'CLOSE_LISTENER_FAILED')
    assert.equal(errors[0].cause, failure)
    assert.match(errors[0].message, /关闭保护暂时不可用/)
    assert.equal(flushes, 0)
    assert.deepEqual(bridge.calls.map(({ command }) => command), ['plugin:event|listen'])
  } finally {
    dispose()
    await nextTurn()
    bridge.restore()
  }
})

test('failed editor flush keeps the window open, reports the failure, and allows a later close retry', async () => {
  const bridge = installNativeBridge()
  const errors: Error[] = []
  const failure = new Error('synthetic save failure')
  let shouldFail = true
  let flushes = 0
  const dispose = new DesktopLifePlatform().registerCloseHandler(async () => {
    flushes += 1
    if (shouldFail) throw failure
  }, (error) => errors.push(error))
  try {
    await nextTurn()
    await bridge.requestClose()
    assert.equal(errors.length, 1)
    assert.ok(errors[0] instanceof PersistenceError)
    assert.equal(errors[0].code, 'CLOSE_FLUSH_FAILED')
    assert.equal(errors[0].cause, failure)
    assert.match(errors[0].message, /窗口已保留/)
    assert.deepEqual(bridge.calls.map(({ command }) => command), ['plugin:event|listen', 'cancel_close'])

    shouldFail = false
    await bridge.requestClose()
    assert.equal(flushes, 2)
    assert.equal(errors.length, 1)
    assert.equal(bridge.calls.at(-1)?.command, 'confirm_close')
  } finally {
    dispose()
    await nextTurn()
    bridge.restore()
  }
})

test('native close confirmation waits for editor flush and coalesces repeated close requests', async () => {
  const bridge = installNativeBridge()
  const pendingSave = deferred<void>()
  const errors: Error[] = []
  let flushes = 0
  const dispose = new DesktopLifePlatform().registerCloseHandler(async () => {
    flushes += 1
    await pendingSave.promise
  }, (error) => errors.push(error))
  try {
    await nextTurn()
    const firstClose = bridge.requestClose()
    await bridge.requestClose()
    assert.equal(flushes, 1)
    assert.deepEqual(bridge.calls.map(({ command }) => command), ['plugin:event|listen'])

    pendingSave.resolve()
    await firstClose
    assert.deepEqual(bridge.calls.map(({ command }) => command), ['plugin:event|listen', 'confirm_close'])
    assert.deepEqual(errors, [])
  } finally {
    pendingSave.resolve()
    dispose()
    await nextTurn()
    bridge.restore()
  }
})

test('native close confirmation failure is reported and cancels the pending close', async () => {
  const bridge = installNativeBridge({ confirmError: new Error('synthetic close IPC failure') })
  const errors: Error[] = []
  const dispose = new DesktopLifePlatform().registerCloseHandler(async () => undefined, (error) => errors.push(error))
  try {
    await nextTurn()
    await bridge.requestClose()
    assert.equal(errors.length, 1)
    assert.ok(errors[0] instanceof PersistenceError)
    assert.equal(errors[0].code, 'CLOSE_FLUSH_FAILED')
    assert.deepEqual(bridge.calls.map(({ command }) => command), ['plugin:event|listen', 'confirm_close', 'cancel_close'])
  } finally {
    dispose()
    await nextTurn()
    bridge.restore()
  }
})

test('disposing before listener registration completes removes it and prevents stale close callbacks', async () => {
  const registration = deferred<number>()
  const bridge = installNativeBridge({ listenResult: registration.promise })
  let flushes = 0
  const errors: Error[] = []
  const dispose = new DesktopLifePlatform().registerCloseHandler(async () => { flushes += 1 }, (error) => errors.push(error))
  try {
    dispose()
    registration.resolve(42)
    await nextTurn()
    await bridge.requestClose()
    assert.equal(flushes, 0)
    assert.deepEqual(errors, [])
    assert.deepEqual(bridge.removed, [{ event: CLOSE_EVENT, eventId: 42 }])
    assert.deepEqual(bridge.calls.map(({ command }) => command), ['plugin:event|listen', 'plugin:event|unlisten'])
  } finally {
    dispose()
    await nextTurn()
    bridge.restore()
  }
})

test('backup and diary pickers call the native dialog API and preserve the selected local path', async () => {
  const selectedPath = 'D:/synthetic/日记包.zip'
  const bridge = installNativeBridge({ selectedPath })
  try {
    assert.equal(await chooseBackupDestination(), selectedPath)
    assert.equal(await chooseBackupArchive(), selectedPath)
    assert.equal(await chooseDiaryExportPath(), selectedPath)
    assert.equal(await chooseDiaryImportPath(), selectedPath)
    assert.deepEqual(bridge.calls.map(({ command }) => command), [
      'plugin:dialog|save', 'plugin:dialog|open', 'plugin:dialog|save', 'plugin:dialog|open',
    ])
    assert.deepEqual(bridge.calls.map(({ args }) => (args?.options as { title: string }).title), [
      '导出 life-timeline 备份', '选择 life-timeline 备份', '导出日记 ZIP', '导入日记 ZIP',
    ])
  } finally {
    bridge.restore()
  }
})
