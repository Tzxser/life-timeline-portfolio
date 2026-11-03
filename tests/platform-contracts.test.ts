import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PersistenceError,
  cloneSnapshot,
  isLifeSnapshot,
  makeSnapshot,
  normalizeFlushResult,
  normalizeLoadResult,
  normalizeSaveAck,
} from '../lib/platform/contracts'

const event = {
  id: 'event-contract',
  title: '契约测试',
  date: '2026-09-28',
  displayDate: '2026 年 9 月 28 日',
  datePrecision: 'day' as const,
  stageId: null,
  importance: 2,
  summary: '',
  content: '一段正文',
  richContent: {
    version: 1 as const,
    format: 'tiptap-json' as const,
    doc: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '一段正文' }] }],
    },
  },
}

test('makeSnapshot creates a versioned local boundary and cloneSnapshot breaks object identity', () => {
  const original = makeSnapshot([event], [], 4, { epoch: 2 })
  assert.equal(isLifeSnapshot(original), true)

  const clone = cloneSnapshot(original)
  assert.deepEqual(clone, original)
  assert.notEqual(clone, original)
  assert.notEqual(clone.events, original.events)
  assert.notEqual(clone.events[0], original.events[0])
  assert.notEqual(clone.events[0].richContent, original.events[0].richContent)
  assert.notEqual(clone.meta, original.meta)

  clone.events[0].richContent!.doc.content![0].content![0].text = '只改副本'
  assert.equal(original.events[0].richContent!.doc.content![0].content![0].text, '一段正文')
})

test('snapshot validation rejects partial or unsafe revisions instead of falling back to mock data', () => {
  assert.equal(isLifeSnapshot({ schemaVersion: 1, events: [], stages: [], revision: 0 }), true)
  assert.equal(isLifeSnapshot({ schemaVersion: 1, events: [], stages: [], revision: -1 }), false)
  assert.equal(isLifeSnapshot({ schemaVersion: 1, events: [], stages: [], revision: Number.NaN }), false)
  assert.equal(isLifeSnapshot({ schemaVersion: 2, events: [], stages: [], revision: 0 }), false)
  assert.equal(isLifeSnapshot(null), false)

  assert.throws(
    () => normalizeLoadResult({ events: [], stages: [], revision: 0 }),
    (error: unknown) => error instanceof PersistenceError && error.code === 'INVALID_SNAPSHOT',
  )
  assert.throws(
    () => normalizeLoadResult({ snapshot: { schemaVersion: 1, events: [], stages: [], revision: 0 }, revision: -2 }),
    (error: unknown) => error instanceof PersistenceError && error.code === 'INVALID_REVISION',
  )
})

test('load and ACK normalization uses explicit revisions and never invents a negative version', () => {
  const loaded = normalizeLoadResult({
    snapshot: makeSnapshot([], [], 3),
    revision: 7,
  })
  assert.equal(loaded.revision, 7)
  assert.equal(loaded.snapshot.revision, 7)

  assert.deepEqual(normalizeSaveAck(undefined, 8), { revision: 8 })
  assert.deepEqual(normalizeSaveAck({ revision: 9 }, 8), { revision: 9 })
  assert.deepEqual(normalizeSaveAck(10, 8), { revision: 10 })
  assert.deepEqual(normalizeFlushResult(undefined, 11), { revision: 11 })

  assert.throws(
    () => normalizeSaveAck({ revision: Number.POSITIVE_INFINITY }, 1),
    (error: unknown) => error instanceof PersistenceError && error.code === 'INVALID_ACK',
  )
  assert.throws(
    () => normalizeFlushResult({ revision: -1 }, 1),
    (error: unknown) => error instanceof PersistenceError && error.code === 'INVALID_FLUSH',
  )
})
