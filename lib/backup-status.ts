'use client'

import { useEffect, useSyncExternalStore } from 'react'
import { listen } from '@tauri-apps/api/event'
import { getBackupStatus, type BackupStatusResult } from '@/lib/desktop-commands'
import { isDesktopRuntime } from '@/lib/platform'

const EVENT_NAME = 'life-timeline://backup-status'

let current: BackupStatusResult | null = null
let started = false
let startPromise: Promise<void> | null = null
let unlisten: (() => void) | null = null
const listeners = new Set<() => void>()

function nowIso() {
  return new Date().toISOString()
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() !== '' ? error.message : '无法读取自动备份状态。'
}

function notify() {
  for (const listener of listeners) listener()
}

function setCurrent(next: BackupStatusResult) {
  current = next
  notify()
}

function accept(value: unknown): BackupStatusResult | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Record<string, unknown>
  if (
    candidate.status !== 'running' &&
    candidate.status !== 'success' &&
    candidate.status !== 'error'
  ) return null
  if (typeof candidate.checkedAt !== 'string' || candidate.checkedAt.trim() === '') return null
  return {
    status: candidate.status,
    checkedAt: candidate.checkedAt,
    lastSuccessAt: typeof candidate.lastSuccessAt === 'string' ? candidate.lastSuccessAt : null,
    error: typeof candidate.error === 'string' ? candidate.error : null,
  }
}

async function start(): Promise<void> {
  if (started || startPromise) return startPromise ?? Promise.resolve()
  started = true
  if (!isDesktopRuntime()) return
  startPromise = (async () => {
    try {
      setCurrent(await getBackupStatus())
    } catch (error) {
      setCurrent({ status: 'error', checkedAt: nowIso(), lastSuccessAt: null, error: errorMessage(error) })
    }

    try {
      unlisten = await listen<unknown>(EVENT_NAME, (event) => {
        const next = accept(event.payload)
        if (next) setCurrent(next)
        else setCurrent({ status: 'error', checkedAt: nowIso(), lastSuccessAt: current?.lastSuccessAt ?? null, error: '自动备份状态返回格式无效。' })
      })
    } catch (error) {
      // The command result remains useful even if the optional event bridge is
      // unavailable. Surface the bridge failure only when no status exists.
      if (!current) setCurrent({ status: 'error', checkedAt: nowIso(), lastSuccessAt: null, error: errorMessage(error) })
    }
  })().finally(() => {
    startPromise = null
  })
  return startPromise
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  void start()
  return () => listeners.delete(listener)
}

function getSnapshot() {
  return current
}

function getServerSnapshot() {
  return null
}

export function useBackupStatus(): BackupStatusResult | null {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  useEffect(() => {
    void start()
    return () => {
      // The global listener is shared by the main alert and settings drawer;
      // it intentionally stays active for the lifetime of the desktop page.
    }
  }, [])
  return snapshot
}

export async function refreshBackupStatus(): Promise<BackupStatusResult | null> {
  if (!isDesktopRuntime()) return null
  try {
    const next = await getBackupStatus()
    setCurrent(next)
    return next
  } catch (error) {
    const next: BackupStatusResult = {
      status: 'error',
      checkedAt: nowIso(),
      lastSuccessAt: current?.lastSuccessAt ?? null,
      error: errorMessage(error),
    }
    setCurrent(next)
    return next
  }
}

export function disposeBackupStatusListener() {
  unlisten?.()
  unlisten = null
  started = false
  startPromise = null
}

