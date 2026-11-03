import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'

import {
  PersistenceError,
  makeSnapshot,
  type LifePlatform,
  type SaveSnapshotRequest,
} from '../lib/platform/contracts'
import { RevisionedSaveQueue } from '../lib/persistence/save-queue'

function snapshot(content: string, revision = 0) {
  return makeSnapshot(
    [{
      id: 'event-queue',
      title: '队列测试',
      date: '2026-09-28',
      displayDate: '2026 年 9 月 28 日',
      datePrecision: 'day',
      stageId: null,
      importance: 2,
      summary: '',
      content,
    }],
    [],
    revision,
  )
}

function recordingPlatform(
  save: (request: SaveSnapshotRequest) => Promise<{ revision: number }>,
): LifePlatform & { requests: SaveSnapshotRequest[] } {
  const requests: SaveSnapshotRequest[] = []
  return {
    kind: 'browser',
    requests,
    async loadSnapshot() {
      return { snapshot: snapshot('loaded'), revision: 0 }
    },
    async saveSnapshot(request) {
      requests.push(request)
      return save(request)
    },
    async flush(revision = 0) {
      return { revision }
    },
  }
}

test('rapid edits coalesce to the newest immutable snapshot and retain revision order', async () => {
  const platform = recordingPlatform(async (request) => ({ revision: request.revision }))
  const states: string[] = []
  const queue = new RevisionedSaveQueue({
    adapter: platform,
    debounceMs: 250,
    maxWaitMs: 500,
    onStateChange: (state) => states.push(state.status),
  })

  queue.enqueue(snapshot('第一笔'))
  queue.enqueue(snapshot('第二笔'))
  const latestRevision = queue.enqueue(snapshot('最后一笔'))
  await queue.flush()

  assert.equal(platform.requests.length, 1)
  assert.equal(platform.requests[0]?.snapshot.events[0]?.content, '最后一笔')
  assert.equal(platform.requests[0]?.revision, latestRevision)
  assert.equal(queue.getState().status, 'saved')
  assert.equal(queue.getState().lastSavedRevision, latestRevision)
  assert.ok(states.includes('saving'))
  assert.ok(states.includes('saved'))
})

test('the queue clones input before awaiting an adapter, preventing post-enqueue mutation', async () => {
  const platform = recordingPlatform(async (request) => ({ revision: request.revision }))
  const queue = new RevisionedSaveQueue({ adapter: platform, debounceMs: 500, maxWaitMs: 500 })
  const original = snapshot('提交前的正文')
  queue.enqueue(original)
  original.events[0]!.content = '提交后的外部突变'
  await queue.flush()

  assert.equal(platform.requests[0]?.snapshot.events[0]?.content, '提交前的正文')
})

test('a failed save remains pending and retry can recover without dropping the last revision', async () => {
  let fail = true
  const platform = recordingPlatform(async (request) => {
    if (fail) throw new Error('磁盘暂时不可写')
    return { revision: request.revision }
  })
  const queue = new RevisionedSaveQueue({ adapter: platform, debounceMs: 500, maxWaitMs: 500 })
  const revision = queue.enqueue(snapshot('需要重试'))

  await assert.rejects(queue.flush(), /磁盘暂时不可写/)
  const failed = queue.getState()
  assert.equal(failed.status, 'error')
  assert.equal(failed.pendingRevision, revision)
  assert.match(failed.error ?? '', /磁盘暂时不可写/)

  fail = false
  await queue.retry()
  const recovered = queue.getState()
  assert.equal(recovered.status, 'saved')
  assert.equal(recovered.lastSavedRevision, revision)
  assert.equal(platform.requests.length, 2)
})

test('a stale adapter acknowledgement is a hard error rather than a false saved state', async () => {
  const platform = recordingPlatform(async (request) => ({ revision: request.revision - 1 }))
  const queue = new RevisionedSaveQueue({ adapter: platform, debounceMs: 500, maxWaitMs: 500 })
  queue.enqueue(snapshot('旧确认'))

  await assert.rejects(
    queue.flush(),
    (error: unknown) => error instanceof PersistenceError && error.code === 'STALE_ACK',
  )
  assert.equal(queue.getState().status, 'error')
  assert.equal(queue.getState().lastSavedRevision, 0)
})

test('a newer edit queued while an older write is in flight is sent after the older ACK', async () => {
  let releaseFirst: ((value: { revision: number }) => void) | undefined
  const platform = recordingPlatform((request) => {
    if (platform.requests.length === 1) {
      return new Promise((resolve) => {
        releaseFirst = resolve
      })
    }
    return Promise.resolve({ revision: request.revision })
  })
  const queue = new RevisionedSaveQueue({ adapter: platform, debounceMs: 500, maxWaitMs: 500 })
  const first = queue.enqueue(snapshot('第一版'))
  const draining = queue.flush()
  await setImmediate()
  const second = queue.enqueue(snapshot('第二版'))
  assert.ok(second > first)
  releaseFirst?.({ revision: first })
  await draining

  assert.deepEqual(platform.requests.map((request) => request.revision), [first, second])
  assert.deepEqual(
    platform.requests.map((request) => request.snapshot.events[0]?.content),
    ['第一版', '第二版'],
  )
  assert.equal(queue.getState().lastSavedRevision, second)
})

test('disposed queues stop accepting new work', () => {
  const platform = recordingPlatform(async (request) => ({ revision: request.revision }))
  const queue = new RevisionedSaveQueue({ adapter: platform })
  queue.dispose()
  assert.throws(
    () => queue.enqueue(snapshot('已关闭')),
    (error: unknown) => error instanceof PersistenceError && error.code === 'QUEUE_DISPOSED',
  )
})

