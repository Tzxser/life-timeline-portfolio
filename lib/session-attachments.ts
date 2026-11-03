// 平台无关的附件入口。
//
// 浏览器继续使用会话 Blob；Tauri 窗口由 lib/attachments/desktop.ts 将文件
// 复制到受控附件目录，并只把稳定的 attachmentId 与 asset URL 交给 React。
// 调用方不要把绝对路径、blob URL 或数据库内容写入正文 JSON。

import type { AttachmentMeta } from '@/types/life-event'
import {
  attachmentServiceKind,
  commitFile,
  downloadAttachment,
  fileExtension,
  formatBytes,
  getAttachment,
  getRetainedAttachmentBytes,
  hydrateAttachments,
  inspectFiles,
  resolveAttachment,
  saveAttachmentAs,
  subscribeAttachments,
  useAttachment,
  useAttachmentVersion,
  validateFileName,
} from './attachments'
import type {
  AttachmentImportContext,
  AttachmentIntakeResult,
  AttachmentSnapshot,
  DesktopAttachmentRecord,
} from './attachments'

/** Kept as a named alias for the existing editor contract. */
export type IntakeResult = AttachmentIntakeResult
export type SessionEntry = AttachmentSnapshot

/**
 * R3 limits are retained as the public compatibility object.  The 200 MiB
 * value is a browser-held blob budget only; desktop history is persisted on
 * disk and does not consume it.
 */
export const ATTACHMENT_LIMITS = {
  imageMaxBytes: 10 * 1024 * 1024,
  fileMaxBytes: 50 * 1024 * 1024,
  batchMax: 10,
  sessionMaxBytes: 200 * 1024 * 1024,
} as const

export {
  attachmentServiceKind,
  commitFile,
  downloadAttachment,
  fileExtension,
  formatBytes,
  getAttachment,
  getRetainedAttachmentBytes,
  hydrateAttachments,
  inspectFiles,
  resolveAttachment,
  saveAttachmentAs,
  subscribeAttachments,
  useAttachment,
  useAttachmentVersion,
  validateFileName,
}

export type { AttachmentImportContext, AttachmentSnapshot, DesktopAttachmentRecord }
export type { AttachmentMeta }

