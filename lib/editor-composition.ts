export class CompositionSettleError extends Error {
  constructor() {
    super('输入法仍在确认文字，请回到正文完成输入后重试。当前内容和窗口已保留。')
    this.name = 'CompositionSettleError'
  }
}

/** Never treat an unresolved IME composition as a successful save/close. */
export async function waitForComposition(options: {
  isComposing: () => boolean
  endedAt: () => number
  settleMs?: number
  timeoutMs?: number
}): Promise<void> {
  const settleMs = options.settleMs ?? 80
  const timeoutMs = options.timeoutMs ?? 2000
  const started = Date.now()
  while (options.isComposing() || Date.now() - options.endedAt() < settleMs) {
    if (Date.now() - started >= timeoutMs) throw new CompositionSettleError()
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
