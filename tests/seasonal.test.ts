import assert from 'node:assert/strict'
import test from 'node:test'

import { seasonForMonth } from '../lib/seasonal'

test('seasonForMonth follows the local Chinese four-season month ranges', () => {
  assert.equal(seasonForMonth(3), 'spring')
  assert.equal(seasonForMonth(5), 'spring')
  assert.equal(seasonForMonth(6), 'summer')
  assert.equal(seasonForMonth(8), 'summer')
  assert.equal(seasonForMonth(9), 'autumn')
  assert.equal(seasonForMonth(11), 'autumn')
  assert.equal(seasonForMonth(12), 'winter')
  assert.equal(seasonForMonth(2), 'winter')
})

test('seasonForMonth clamps invalid month values without creating a new season', () => {
  assert.equal(seasonForMonth(0), 'winter')
  assert.equal(seasonForMonth(13), 'winter')
})
