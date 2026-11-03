import { open, save } from '@tauri-apps/plugin-dialog'

/** Module evaluation is SSR-safe; the native functions run only on user action. */
export async function chooseBackupDestination(): Promise<string | null> {
  return save({
    title: '导出 life-timeline 备份',
    defaultPath: 'life-timeline-backup.zip',
    filters: [{ name: 'life-timeline 备份', extensions: ['zip'] }],
  })
}

export async function chooseBackupArchive(): Promise<string | null> {
  const value = await open({
    title: '选择 life-timeline 备份',
    multiple: false,
    directory: false,
    filters: [{ name: 'life-timeline 备份', extensions: ['zip'] }],
  })
  return typeof value === 'string' ? value : null
}
