import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BACKUP_ARCHIVE_FORMAT_VERSION,
  BACKUP_SCHEMA_VERSION,
  BACKUP_SECURITY_LIMITS,
  normalizeArchivePath,
  validateArchiveEntries,
  validateBackupArchive,
  validateBackupDocument,
  validateBackupManifest,
} from '../lib/backup-contract'

const HASH = 'a'.repeat(64)

function entry(path: string, overrides: Record<string, unknown> = {}) {
  return {
    path,
    compressedSize: 100,
    uncompressedSize: 100,
    ...overrides,
  }
}

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    archiveFormatVersion: BACKUP_ARCHIVE_FORMAT_VERSION,
    appVersion: '0.1.0',
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: '2026-09-28T09:00:00+08:00',
    files: [
      { path: 'manifest.json', sha256: HASH, byteSize: 512 },
      { path: 'life.json', sha256: HASH, byteSize: 1024 },
      { path: 'attachments/photo.jpg', sha256: HASH, byteSize: 2048 },
    ],
    ...overrides,
  }
}

function document(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: '2026-09-28T09:00:00+08:00',
    stages: [
      {
        id: 'stage-1',
        name: '独立生活',
        type: 'range',
        startDate: '2025-01',
        startDisplay: '2025 年 1 月',
        startPrecision: 'month',
        endDate: null,
        endDisplay: null,
        endPrecision: null,
        isOngoing: true,
        description: '',
      },
    ],
    events: [
      {
        id: 'event-1',
        title: '带照片的记录',
        date: '2026-09-28',
        displayDate: '2026 年 9 月 28 日',
        datePrecision: 'day',
        stageId: 'stage-1',
        importance: 3,
        summary: '',
        content: '正文',
        attachmentIds: ['att-1'],
        richContent: {
          version: 1,
          format: 'tiptap-json',
          doc: {
            type: 'doc',
            content: [{ type: 'lifeImage', attrs: { attachmentId: 'att-1' } }],
          },
        },
      },
    ],
    attachments: [
      {
        id: 'att-1',
        name: 'photo.jpg',
        mimeType: 'image/jpeg',
        byteSize: 2048,
        kind: 'image',
        path: 'attachments/photo.jpg',
        sha256: HASH,
      },
    ],
    ...overrides,
  }
}

test('normalizeArchivePath rejects traversal, host paths, device names, and path confusion', () => {
  const cases = [
    ['../outside.txt', 'parent_path'],
    ['attachments/../../outside.txt', 'parent_path'],
    ['/absolute.txt', 'absolute_path'],
    ['C:/absolute.txt', 'absolute_path'],
    ['\\\\server\\share\\file.txt', 'unsafe_path'],
    ['attachments/file:name.jpg', 'absolute_path'],
    ['attachments//file.jpg', 'unsafe_path'],
    ['attachments/./file.jpg', 'unsafe_path'],
    ['attachments/CON.txt', 'device_name'],
    ['attachments/file.txt ', 'unsafe_path'],
  ] as const

  for (const [path, code] of cases) {
    const result = normalizeArchivePath(path)
    assert.equal(result.ok, false, path)
    assert.equal(result.diagnostics[0]?.code, code, path)
  }

  assert.equal(normalizeArchivePath('attachments/photo.jpg').ok, true)
})

test('archive entry validation blocks symlinks, case collisions, directories, and compression bombs', () => {
  const result = validateArchiveEntries([
    entry('manifest.json'),
    entry('MANIFEST.JSON'),
    entry('attachments/link', { isSymlink: true }),
    entry('attachments/reparse', { isReparsePoint: true }),
    entry('attachments/folder', { isDirectory: true }),
    entry('attachments/zero.zip', { compressedSize: 0, uncompressedSize: 1 }),
    entry('attachments/bomb.bin', { compressedSize: 1, uncompressedSize: 201 }),
  ])
  assert.equal(result.ok, false)
  const codes = result.diagnostics.map((diagnostic) => diagnostic.code)
  assert.ok(codes.includes('path_conflict'))
  assert.ok(codes.includes('symlink_entry'))
  assert.ok(codes.includes('directory_entry'))
  assert.ok(codes.includes('compression_bomb'))
})

test('manifest validation requires the two core files and canonical SHA-256 metadata', () => {
  const valid = validateBackupManifest(manifest())
  assert.equal(valid.ok, true)
  assert.equal(valid.value?.files.length, 3)
  assert.equal(valid.value?.files[0]?.sha256, HASH)

  const invalid = validateBackupManifest(
    manifest({
      archiveFormatVersion: 99,
      schemaVersion: BACKUP_SCHEMA_VERSION + 1,
      files: [
        { path: 'manifest.json', sha256: 'not-a-hash', byteSize: 1 },
        { path: 'manifest.json', sha256: HASH, byteSize: 1 },
      ],
    }),
  )
  assert.equal(invalid.ok, false)
  const codes = invalid.diagnostics.map((diagnostic) => diagnostic.code)
  assert.ok(codes.includes('unsupported_archive_format'))
  assert.ok(codes.includes('unsupported_schema'))
  assert.ok(codes.includes('invalid_hash'))
  assert.ok(codes.includes('path_conflict'))
  assert.ok(codes.includes('missing_required_entry'))
})

test('document validation catches duplicate IDs, stage-all writes, and missing attachment references', () => {
  const valid = validateBackupDocument(document())
  assert.equal(valid.ok, true)

  const stages = [
    ...(document().stages as Array<Record<string, unknown>>),
    { ...(document().stages as Array<Record<string, unknown>>)[0], id: 'stage-1' },
    { ...(document().stages as Array<Record<string, unknown>>)[0], id: 'stage-all' },
  ]
  const brokenEvent = {
    ...(document().events as Array<Record<string, unknown>>)[0],
    stageId: 'missing-stage',
    attachmentIds: ['missing-attachment'],
  }
  const invalid = validateBackupDocument(document({ stages, events: [brokenEvent] }))
  assert.equal(invalid.ok, false)
  const codes = invalid.diagnostics.map((diagnostic) => diagnostic.code)
  assert.ok(codes.includes('duplicate_id'))
  assert.ok(codes.includes('invalid_document'))
  assert.ok(codes.includes('missing_attachment'))
})

test('archive validation binds manifest names, central-directory entries, and document references', () => {
  const valid = validateBackupArchive({
    entries: [entry('manifest.json'), entry('life.json'), entry('attachments/photo.jpg')],
    manifest: manifest(),
    document: document(),
  })
  assert.equal(valid.ok, true)
  assert.equal(valid.value?.document?.events.length, 1)

  const unexpected = validateBackupArchive({
    entries: [entry('manifest.json'), entry('life.json'), entry('notes.txt')],
    manifest: manifest(),
  })
  assert.equal(unexpected.ok, false)
  assert.ok(unexpected.diagnostics.some((diagnostic) => diagnostic.code === 'unexpected_entry'))

  const absent = validateBackupArchive({
    entries: [entry('manifest.json'), entry('life.json')],
    manifest: manifest(),
  })
  assert.equal(absent.ok, false)
  assert.ok(absent.diagnostics.some((diagnostic) => diagnostic.code === 'missing_required_entry'))
})

test('security limits remain explicit and bounded for callers that scan before extraction', () => {
  assert.ok(BACKUP_SECURITY_LIMITS.maxEntries >= 1_000)
  assert.ok(BACKUP_SECURITY_LIMITS.maxEntryBytes > 0)
  assert.ok(BACKUP_SECURITY_LIMITS.maxCompressionRatio > 1)
  assert.ok(BACKUP_SECURITY_LIMITS.maxJsonDepth < 1_000)
})
