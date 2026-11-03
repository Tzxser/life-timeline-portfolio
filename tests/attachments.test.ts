import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ATTACHMENT_LIMITS,
  commitFile,
  fileExtension,
  formatBytes,
  getAttachment,
  getRetainedAttachmentBytes,
  inspectFiles,
  validateFileName,
} from '../lib/session-attachments'
import { createDesktopAttachmentService } from '../lib/attachments/desktop'

function file(name: string, contents: string | Uint8Array = '内容', type = 'text/plain') {
  return new File([contents], name, { type, lastModified: 1_725_000_000_000 })
}

test('inspectFiles keeps batch order and rejects active executable formats', async () => {
  const results = await inspectFiles([
    file('notes.txt'),
    file('dangerous.Ps1', 'Write-Host danger', 'text/plain'),
    file('empty.bin', new Uint8Array(0), 'application/octet-stream'),
    file('drawing.svg', '<svg></svg>', 'image/svg+xml'),
  ])

  assert.equal(results.length, 4)
  assert.equal(results[0]?.ok, true)
  const blocked = results[1]
  assert.equal(blocked?.ok, false)
  assert.ok(blocked && !blocked.ok)
  assert.match(blocked.reason, /不能作为附件添加/)
  const empty = results[2]
  assert.equal(empty?.ok, false)
  assert.ok(empty && !empty.ok)
  assert.match(empty.reason, /文件为空/)
  assert.equal(results[3]?.ok, true)
  if (results[3]?.ok) {
    assert.equal(results[3].kind, 'file')
    assert.match(results[3].note ?? '', /暂不支持图片预览/)
  }
})

test('inspectFiles applies per-kind size limits before attempting image decode', async () => {
  const tooLargeImage = file(
    'too-large.png',
    new Uint8Array(ATTACHMENT_LIMITS.imageMaxBytes + 1),
    'image/png',
  )
  const results = await inspectFiles([tooLargeImage])
  assert.equal(results.length, 1)
  assert.equal(results[0]?.ok, false)
  assert.match(results[0]?.ok ? '' : results[0]?.reason ?? '', /图片超过/)
})

test('the eleventh item fails without changing the result order', async () => {
  const results = await inspectFiles(
    Array.from({ length: ATTACHMENT_LIMITS.batchMax + 1 }, (_, index) => file(`note-${index}.txt`)),
  )
  assert.equal(results.length, ATTACHMENT_LIMITS.batchMax + 1)
  assert.ok(results.slice(0, ATTACHMENT_LIMITS.batchMax).every((result) => result.ok))
  const rejected = results[ATTACHMENT_LIMITS.batchMax]
  assert.equal(rejected?.ok, false)
  if (rejected && !rejected.ok) {
    assert.match(rejected.reason, /最多添加/)
  }
})

test('commitFile persists only metadata while getAttachment retains the original bytes', async () => {
  const source = file('中文 文件.txt', '本地附件的内容')
  const [result] = await inspectFiles([source])
  assert.ok(result?.ok)
  if (!result?.ok) return

  const meta = await commitFile(result)
  assert.ok(meta)
  if (!meta) return
  assert.equal(meta.name, '中文 文件.txt')
  assert.equal(meta.byteSize, source.size)
  assert.equal(meta.kind, 'file')
  assert.equal(JSON.stringify(meta).includes('blob:'), false)
  assert.equal(JSON.stringify(meta).includes('本地附件的内容'), false)

  const entry = getAttachment(meta.id)
  assert.ok(entry)
  if (!entry) return
  assert.equal(entry.meta.id, meta.id)
  assert.equal(entry.blob, source)
  assert.equal(typeof entry.url, 'string')
  assert.equal((await entry.blob.text()), '本地附件的内容')
})

test('filename and byte formatting are deterministic for archive metadata and UI labels', () => {
  assert.equal(fileExtension('照片.JPG'), 'jpg')
  assert.equal(fileExtension('.env'), '')
  assert.equal(fileExtension('no-extension'), '')
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(1024), '1.0 KB')
  assert.equal(formatBytes(ATTACHMENT_LIMITS.imageMaxBytes), '10.0 MB')
  assert.equal(validateFileName('普通文件.txt'), null)
  assert.match(validateFileName('../outside.txt') ?? '', /路径分隔符/)
  assert.match(validateFileName('') ?? '', /为空或无效/)
})

test('a cancelled import context cannot commit a file into the active attachment index', async () => {
  const source = file('cancelled.txt', '不应落盘')
  const [result] = await inspectFiles([source])
  assert.ok(result?.ok)
  if (!result?.ok) return

  const before = getRetainedAttachmentBytes()
  const meta = await commitFile(result, { docKey: 'old-document', epoch: 1, isCurrent: () => false })
  assert.equal(meta, null)
  assert.equal(getRetainedAttachmentBytes(), before)
})

test('desktop attachment IPC keeps request envelopes and trusts only the native asset URL', async () => {
  const calls: Array<{ command: string; args: unknown }> = []
  const previous = (globalThis as typeof globalThis & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  Object.defineProperty(globalThis, '__TAURI_INTERNALS__', {
    configurable: true,
    value: {
      invoke: async (command: string, args: unknown) => {
        calls.push({ command, args })
        if (command === 'import_attachment') {
          return {
            meta: {
              id: 'att-native',
              name: 'photo.jpg',
              mimeType: 'image/jpeg',
              byteSize: 3,
              kind: 'image',
            },
            relativePath: 'attachments/ab/hash.jpg',
            assetUrl: 'http://asset.localhost/C%3A%5Cdata%5Cattachments%5Cab%5Chash.jpg',
          }
        }
        if (command === 'attachment_path') {
          return {
            relativePath: 'attachments/ab/cold.jpg',
            assetUrl: 'http://asset.localhost/C%3A%5Cdata%5Cattachments%5Cab%5Ccold.jpg',
          }
        }
        if (command === 'save_attachment_as') return { ok: true }
        throw new Error(`unexpected command ${command}`)
      },
    },
  })
  try {
    const service = createDesktopAttachmentService()
    const source = file('photo.jpg', new Uint8Array([1, 2, 3]), 'image/jpeg')
    const meta = await service.commitFile({
      ok: true,
      file: source,
      kind: 'image',
      mimeType: 'image/jpeg',
      width: 1,
      height: 1,
    })
    assert.equal(meta?.id, 'att-native')
    assert.equal(
      calls[0]?.args && (calls[0].args as { request?: { name?: string } }).request?.name,
      'photo.jpg',
    )
    const snapshot = service.getAttachment('att-native')
    assert.equal(snapshot?.url, 'http://asset.localhost/C%3A%5Cdata%5Cattachments%5Cab%5Chash.jpg')
    assert.equal(await service.saveAttachmentAs('att-native', 'C:\\export\\photo.jpg'), true)
    assert.deepEqual(calls[1], {
      command: 'save_attachment_as',
      args: { request: { id: 'att-native', targetPath: 'C:\\export\\photo.jpg' } },
    })
    await service.hydrate([
      {
        meta: {
          id: 'att-cold',
          name: 'cold.jpg',
          mimeType: 'image/jpeg',
          byteSize: 3,
          kind: 'image',
        },
        relativePath: 'attachments/ab/cold.jpg',
      },
    ])
    assert.equal(
      service.getAttachment('att-cold')?.url,
      'http://asset.localhost/C%3A%5Cdata%5Cattachments%5Cab%5Ccold.jpg',
    )
    assert.deepEqual(calls[2], {
      command: 'attachment_path',
      args: { request: { id: 'att-cold' } },
    })
  } finally {
    if (previous === undefined) delete (globalThis as typeof globalThis & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
    else Object.defineProperty(globalThis, '__TAURI_INTERNALS__', { configurable: true, value: previous })
  }
})
