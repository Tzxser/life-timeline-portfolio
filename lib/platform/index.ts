import type { LifeEvent } from '@/types/life-event'
import type { LifeStage } from '@/types/life-stage'
import { BrowserLifePlatform } from './browser'
import type { LifePlatform } from './contracts'
import { DesktopLifePlatform, isDesktopRuntime } from './desktop'

export * from './contracts'
export { BrowserLifePlatform } from './browser'
export { DesktopLifePlatform, isDesktopRuntime } from './desktop'

export interface BrowserPlatformSeed {
  events?: LifeEvent[]
  stages?: LifeStage[]
  revision?: number
}

/**
 * Resolve the platform once on the client.  On the server this intentionally
 * returns the browser adapter; the provider only calls this factory in an
 * effect, so a static export never reaches Tauri during prerendering.
 */
export function createLifePlatform(seed?: BrowserPlatformSeed): LifePlatform {
  return isDesktopRuntime() ? new DesktopLifePlatform() : new BrowserLifePlatform(seed)
}

