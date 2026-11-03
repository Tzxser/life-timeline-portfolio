import { waitForDiaryTransfers } from '@/lib/diary-transfer'
import { waitForAiImports } from '@/lib/ai-import'

const callbacks = new Set<() => Promise<void> | void>()

export function registerBeforePersistenceFlush(callback: () => Promise<void> | void): () => void {
  callbacks.add(callback)
  return () => callbacks.delete(callback)
}

export async function runBeforePersistenceFlush(): Promise<void> {
  await waitForAiImports()
  await waitForDiaryTransfers()
  for (const callback of [...callbacks]) await callback()
}
