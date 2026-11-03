import assert from 'node:assert/strict'
import test from 'node:test'
import { createPhoneTransferLifecycle } from '../lib/phone-transfer-lifecycle'

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

test('closing before native start begins never opens a listener', async () => {
  let starts = 0
  const canceled: string[] = []
  const manager = createPhoneTransferLifecycle({
    async start() { starts += 1; return { sessionId: 'unused' } },
    async cancel(id) { canceled.push(id) },
  })
  const lease = manager.open()
  await lease.close()
  assert.equal(await lease.ready, null)
  assert.equal(starts, 0)
  assert.deepEqual(canceled, [])
})

test('closing during pending native start cancels its eventual session before resolving', async () => {
  const pendingStart = deferred<{ sessionId: string }>()
  const canceled: string[] = []
  const manager = createPhoneTransferLifecycle({
    start: () => pendingStart.promise,
    async cancel(id) { canceled.push(id) },
  })
  const lease = manager.open()
  await nextTurn()
  let closed = false
  const closing = lease.close().then(() => { closed = true })
  await nextTurn()
  assert.equal(closed, false)
  pendingStart.resolve({ sessionId: 'late-start' })
  assert.equal(await lease.ready, null)
  await closing
  assert.equal(lease.sessionId, null)
  assert.deepEqual(canceled, ['late-start'])
})

test('repeated close paths coalesce and target only the page-owned session', async () => {
  const pendingCancel = deferred<void>()
  const canceled: string[] = []
  const manager = createPhoneTransferLifecycle({
    async start() { return { sessionId: 'owned-session' } },
    async cancel(id) { canceled.push(id); await pendingCancel.promise },
  })
  const lease = manager.open()
  await lease.ready
  assert.equal(lease.sessionId, 'owned-session')
  const first = lease.close()
  const second = lease.close()
  assert.equal(first, second)
  assert.equal(lease.sessionId, null)
  await nextTurn()
  assert.deepEqual(canceled, ['owned-session'])
  pendingCancel.resolve()
  await first
  await lease.close()
  assert.deepEqual(canceled, ['owned-session'])
})

test('a reopened page waits for old pending start and cancellation before starting its listener', async () => {
  const firstStart = deferred<{ sessionId: string }>()
  const firstCancel = deferred<void>()
  const operations: string[] = []
  let starts = 0
  const manager = createPhoneTransferLifecycle({
    async start() {
      starts += 1
      operations.push(`start:${starts}`)
      return starts === 1 ? firstStart.promise : { sessionId: 'new-session' }
    },
    async cancel(id) { operations.push(`cancel:${id}`); await firstCancel.promise },
  })
  const old = manager.open()
  await nextTurn()
  const oldClosing = old.close()
  const current = manager.open()
  firstStart.resolve({ sessionId: 'old-session' })
  await nextTurn()
  assert.deepEqual(operations, ['start:1', 'cancel:old-session'])
  firstCancel.resolve()
  await oldClosing
  assert.deepEqual(await current.ready, { sessionId: 'new-session' })
  await old.close()
  assert.equal(current.sessionId, 'new-session')
  assert.deepEqual(operations, ['start:1', 'cancel:old-session', 'start:2'])
})

test('StrictMode-like immediate teardown allows the following mount to start normally', async () => {
  let starts = 0
  const canceled: string[] = []
  const manager = createPhoneTransferLifecycle({
    async start() { starts += 1; return { sessionId: `session-${starts}` } },
    async cancel(id) { canceled.push(id) },
  })
  const discarded = manager.open()
  const closing = discarded.close()
  const kept = manager.open()
  await closing
  assert.equal(await discarded.ready, null)
  assert.deepEqual(await kept.ready, { sessionId: 'session-1' })
  assert.equal(starts, 1)
  assert.deepEqual(canceled, [])
  await kept.close()
  assert.deepEqual(canceled, ['session-1'])
})

test('failed native start does not poison future starts or issue a global cancellation', async () => {
  const failure = new Error('synthetic bind failure')
  let starts = 0
  const canceled: string[] = []
  const manager = createPhoneTransferLifecycle({
    async start() {
      starts += 1
      if (starts === 1) throw failure
      return { sessionId: 'retry-session' }
    },
    async cancel(id) { canceled.push(id) },
  })
  const first = manager.open()
  await assert.rejects(first.ready, failure)
  await first.close()
  const retry = manager.open()
  assert.deepEqual(await retry.ready, { sessionId: 'retry-session' })
  assert.deepEqual(canceled, [])
  await retry.close()
  assert.deepEqual(canceled, ['retry-session'])
})

test('failed cancellation remains retryable without forgetting the owned session', async () => {
  const failure = new Error('synthetic IPC failure')
  const canceled: string[] = []
  const manager = createPhoneTransferLifecycle({
    async start() { return { sessionId: 'retry-close' } },
    async cancel(id) {
      canceled.push(id)
      if (canceled.length === 1) throw failure
    },
  })
  const lease = manager.open()
  await lease.ready
  await assert.rejects(lease.close(), failure)
  await lease.close()
  assert.deepEqual(canceled, ['retry-close', 'retry-close'])
})

test('switching from a pending send offer to receive cancels the offer before opening the receiver', async () => {
  type Offer = { archivePath?: string | null; startDate?: string | null; endDate?: string | null }
  const pendingOffer = deferred<{ sessionId: string }>()
  const requests: Array<Offer | undefined> = []
  const operations: string[] = []
  const manager = createPhoneTransferLifecycle<{ sessionId: string }, Offer>({
    async start(request) {
      requests.push(request)
      operations.push(request ? 'offer' : 'receive')
      return request ? pendingOffer.promise : { sessionId: 'new-receiver' }
    },
    async cancel(id) { operations.push(`cancel:${id}`) },
  })
  const offerRequest = { archivePath: null, startDate: '2026-09-01', endDate: '2026-09-30' }
  const sender = manager.open(offerRequest)
  await nextTurn()
  const closing = sender.close()
  const receiver = manager.open()
  await nextTurn()
  assert.deepEqual(operations, ['offer'])
  pendingOffer.resolve({ sessionId: 'late-offer' })
  assert.equal(await sender.ready, null)
  await closing
  assert.equal((await receiver.ready)?.sessionId, 'new-receiver')
  assert.deepEqual(operations, ['offer', 'cancel:late-offer', 'receive'])
  assert.deepEqual(requests, [offerRequest, undefined])
  await sender.close()
  assert.equal(receiver.sessionId, 'new-receiver')
})

test('failed ZIP offer can be cleaned up and retried without canceling a different session', async () => {
  type Offer = { archivePath: string }
  const operations: string[] = []
  const failure = new Error('synthetic ZIP validation failure')
  const manager = createPhoneTransferLifecycle<{ sessionId: string }, Offer>({
    async start(request) {
      operations.push(request?.archivePath ?? 'receive')
      if (request?.archivePath === 'invalid.zip') throw failure
      return { sessionId: 'valid-offer' }
    },
    async cancel(id) { operations.push(`cancel:${id}`) },
  })
  const failed = manager.open({ archivePath: 'invalid.zip' })
  await assert.rejects(failed.ready, failure)
  await failed.close()
  const retry = manager.open({ archivePath: 'selected.zip' })
  await retry.ready
  await failed.close()
  assert.equal(retry.sessionId, 'valid-offer')
  assert.deepEqual(operations, ['invalid.zip', 'selected.zip'])
  await retry.close()
  assert.equal(operations.at(-1), 'cancel:valid-offer')
})
