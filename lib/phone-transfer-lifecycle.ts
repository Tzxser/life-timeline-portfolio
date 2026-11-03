interface TransferSessionIdentity {
  sessionId: string
}

export interface PhoneTransferLease<Session extends TransferSessionIdentity> {
  readonly ready: Promise<Session | null>
  readonly sessionId: string | null
  close(): Promise<void>
}

/**
 * A page owns only the session it opened. Serialize native start/cancel calls
 * across page instances so a quick reopen (or StrictMode remount) waits for
 * the old page's pending start and cleanup instead of leaking its listener.
 */
export function createPhoneTransferLifecycle<Session extends TransferSessionIdentity, Request = void>(transport: {
  start(request?: Request): Promise<Session>
  cancel(sessionId: string): Promise<void>
}) {
  let tail: Promise<unknown> = Promise.resolve()
  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(operation)
    tail = result.catch(() => undefined)
    return result
  }

  return {
    open(request?: Request): PhoneTransferLease<Session> {
      let closed = false
      let session: Session | null = null
      let closing: Promise<void> | null = null
      const ready = enqueue(async () => {
        if (closed) return null
        session = await transport.start(request)
        return closed ? null : session
      })
      return {
        ready,
        get sessionId() { return closed ? null : session?.sessionId ?? null },
        close() {
          closed = true
          if (closing) return closing
          closing = enqueue(async () => {
            if (!session) return
            // The native side compares this identity atomically. A late
            // cleanup must never cancel another page's newer connection.
            await transport.cancel(session.sessionId)
            session = null
          }).catch((reason: unknown) => {
            closing = null
            throw reason
          })
          return closing
        },
      }
    },
  }
}
