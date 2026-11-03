import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  ATTACHMENT_NODE,
  IMAGE_NODE,
  collectAttachmentIds,
  docForEvent,
  docHasSubstance,
  eventSearchText,
  normalizeImageLayout,
  plainTextToDoc,
} from '../lib/rich-content'
import type { RichDocNode } from '../types/life-event'

const fixturePath = fileURLToPath(new URL('./fixtures/rich-content.json', import.meta.url))
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as RichDocNode

function eventWithDoc(doc: RichDocNode) {
  return {
    id: 'event-fixture',
    title: '海边散步',
    date: '2026-09-27',
    displayDate: '2026 年 9 月 27 日',
    datePrecision: 'day' as const,
    stageId: null,
    importance: 3,
    summary: '退潮后的记录',
    content: '正文摘要',
    richContent: { version: 1 as const, format: 'tiptap-json' as const, doc },
  }
}

test('plainTextToDoc preserves line boundaries and treats markup as text', () => {
  const doc = plainTextToDoc('第一行\n\n<script>alert(1)</script>')
  assert.equal(doc.type, 'doc')
  assert.equal(doc.content?.length, 3)
  assert.deepEqual(doc.content?.[0], {
    type: 'paragraph',
    content: [{ type: 'text', text: '第一行' }],
  })
  assert.deepEqual(doc.content?.[1], { type: 'paragraph' })
  assert.deepEqual(doc.content?.[2], {
    type: 'paragraph',
    content: [{ type: 'text', text: '<script>alert(1)</script>' }],
  })
})

test('docForEvent uses the rich document when present and safely upgrades old text', () => {
  const rich = docForEvent({ richContent: { version: 1, format: 'tiptap-json', doc: fixture }, content: '旧正文' })
  assert.equal(rich, fixture)

  const legacy = docForEvent({ richContent: undefined, content: '保留第一行\n保留第二行' })
  assert.equal(legacy.content?.length, 2)
  assert.equal(legacy.content?.[1]?.content?.[0]?.text, '保留第二行')
})

test('attachment ids are derived from node order, deduplicated, and ignore image-link marks', () => {
  assert.deepEqual(collectAttachmentIds(fixture), ['att-image-1', 'att-audio-1'])

  const misleading: RichDocNode = {
    type: 'doc',
    content: [
      { type: 'text', text: '正文', attrs: { attachmentId: 'should-not-count' } },
      { type: 'paragraph', marks: [{ type: 'imageLink', attrs: { imageId: 'att-image-1' } }] },
    ],
  }
  assert.deepEqual(collectAttachmentIds(misleading), [])
})

test('substance requires meaningful text or a successfully inserted media node', () => {
  assert.equal(docHasSubstance(plainTextToDoc(' \n\t')), false)
  assert.equal(docHasSubstance(plainTextToDoc('  有一个字  ')), true)
  assert.equal(docHasSubstance({ type: 'doc', content: [{ type: IMAGE_NODE, attrs: { attachmentId: 'att-1' } }] }), true)
  assert.equal(docHasSubstance({ type: 'doc', content: [{ type: ATTACHMENT_NODE, attrs: { attachmentId: 'att-2' } }] }), true)
  assert.equal(docHasSubstance({ type: 'doc', content: [{ type: 'imageLink', attrs: { imageId: 'att-3' } }] }), false)
})

test('search text includes user-facing captions and filenames without exposing document JSON', () => {
  const result = eventSearchText(eventWithDoc(fixture))
  assert.match(result, /海边散步/)
  assert.match(result, /退潮后的海边/)
  assert.match(result, /潮声\.wav/)
  assert.doesNotMatch(result, /"attachmentid"/)
  assert.doesNotMatch(result, /blob:/)
})

test('invalid image layouts normalize to the stable block layout', () => {
  assert.equal(normalizeImageLayout('wrap-left'), 'wrap-left')
  assert.equal(normalizeImageLayout('margin-right'), 'margin-right')
  assert.equal(normalizeImageLayout('unsupported'), 'block')
  assert.equal(normalizeImageLayout(null), 'block')
})
