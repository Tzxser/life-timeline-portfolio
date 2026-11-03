import assert from 'node:assert/strict'
import test from 'node:test'
import { CompositionSettleError, waitForComposition } from '../lib/editor-composition'

test('composition completion settles before the save barrier is released', async () => {
  let composing = true, endedAt = 0
  const work = waitForComposition({ isComposing: () => composing, endedAt: () => endedAt, settleMs: 30, timeoutMs: 500 })
  setTimeout(() => { endedAt = Date.now(); composing = false }, 10)
  await work
  assert(Date.now() - endedAt >= 30)
})

test('a missing composition end rejects the close barrier and can be retried safely', async () => {
  let composing = true
  await assert.rejects(waitForComposition({ isComposing: () => composing, endedAt: () => 0, timeoutMs: 40 }), CompositionSettleError)
  assert.equal(composing, true, 'A timeout must not manufacture an IME commit')
  composing = false
  await waitForComposition({ isComposing: () => composing, endedAt: () => 0 })
})
