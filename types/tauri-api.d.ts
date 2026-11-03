/**
 * Compile-time shape for the optional desktop bridge.  The real declaration
 * comes from @tauri-apps/api in a Tauri build; keeping this tiny local shape
 * lets the browser preview type-check before that optional package is
 * installed.
 */
declare module '@tauri-apps/api/core' {
  export function invoke(command: string, args?: Record<string, unknown>): Promise<unknown>
}

declare module '@tauri-apps/api/event' {
  export function listen<T = unknown>(
    event: string,
    handler: (event: { payload: T; id: number }) => void | Promise<void>,
  ): Promise<() => void>
}
