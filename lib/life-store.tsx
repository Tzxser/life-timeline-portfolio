'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { registerBeforePersistenceFlush, runBeforePersistenceFlush } from '@/lib/persistence/flush-barrier'
export { registerBeforePersistenceFlush } from '@/lib/persistence/flush-barrier'
import { MOCK_LIFE_EVENTS } from '@/data/mock-life-events'
import { MOCK_LIFE_STAGES } from '@/data/mock-life-stages'
import { createLifePlatform, type LifePlatform } from '@/lib/platform'
import { makeSnapshot, type LifeSnapshot } from '@/lib/platform/contracts'
import { RevisionedSaveQueue, type SaveQueueState } from '@/lib/persistence/save-queue'
import { hydrateAttachments, type DesktopAttachmentRecord } from '@/lib/attachments'
import { registerDesktopPreferencePersistence, subscribeDesktopPreferenceErrors, type Preferences } from '@/lib/preferences'
import { useStartupPreferences } from '@/lib/startup-preferences'
import { isPageUnloading, markPageUnloading } from '@/lib/page-lifecycle'
import { SeasonalSplash } from '@/components/seasonal-splash'
import { isDailyEntry, makeDailyEntry, patchEventInDateOrder, sortEventsByDate, type LifeEvent } from '@/types/life-event'
import { ALL_STAGE_ID, sortStages, type LifeStage } from '@/types/life-stage'
import { SCHEDULE_KEY, UNDO_KEY, validateSource, type ScheduleSource, type ScheduleUndo } from '@/lib/schedules/model'

export type PersistenceStatus = 'loading' | 'ready' | 'saving' | 'saved' | 'error'

interface LifeStore {
  schedules: ScheduleSource[]
  scheduleUndo: ScheduleUndo | null
  saveSchedules: (sources: ScheduleSource[], undo?: ScheduleUndo | null, events?: LifeEvent[]) => void
  getEvents: () => LifeEvent[]
  initialPreferences: Preferences
  events: LifeEvent[]
  stages: LifeStage[]
  activeStageId: string
  activeStage: LifeStage | null
  pickedStageId: string | null
  selectedId: string | null
  persistenceStatus: PersistenceStatus
  persistenceError: string | null
  platformKind: 'browser' | 'desktop' | null
  selectEvent: (id: string | null) => void
  updateEvent: (id: string, patch: Partial<LifeEvent>) => void
  createEvent: (event: Omit<LifeEvent, 'id'>) => string
  findDailyEntry: (dateKey: string) => LifeEvent | null
  createDailyEntry: (dateKey: string, draft?: Partial<LifeEvent>) => string
  setActiveStageId: (id: string) => void
  pickStage: (id: string) => void
  createStage: (stage: Omit<LifeStage, 'id'>) => string
  updateStage: (id: string, patch: Partial<LifeStage>) => void
  deleteStage: (id: string) => void
  getStageById: (id: string | null) => LifeStage | null
  retryPersistence: () => void
  flushPersistence: () => Promise<void>
  /** Register editor/composition work that must settle before a native flush. */
  registerBeforePersistenceFlush: (callback: () => Promise<void> | void) => () => void
}

const LifeStoreContext = createContext<LifeStore | null>(null)
type DataState = { events: LifeEvent[]; stages: LifeStage[] }

/**
 * A close request can arrive while the editor still owns an IME composition.
 * Keep this small coordination point outside React so native backup/close
 * commands and the store use exactly the same pre-flush barrier.
 */
export function LifeStoreProvider({ children }: { children: ReactNode }) {
  const { showSeasonalSplash } = useStartupPreferences()
  const [events, setEvents] = useState<LifeEvent[]>([])
  const [initialPreferences, setInitialPreferences] = useState<Preferences>({})
  const [stages, setStages] = useState<LifeStage[]>([])
  const [schedules, setSchedules] = useState<ScheduleSource[]>([])
  const [scheduleUndo, setScheduleUndo] = useState<ScheduleUndo | null>(null)
  const [activeStageId, setActiveStageId] = useState(ALL_STAGE_ID)
  const [pickedStageId, setPickedStageId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [persistenceStatus, setPersistenceStatus] = useState<PersistenceStatus>('loading')
  const [hasLoadedLibrary, setHasLoadedLibrary] = useState(false)
  const [persistenceError, setPersistenceError] = useState<string | null>(null)
  const [platformKind, setPlatformKind] = useState<'browser' | 'desktop' | null>(null)
  const [retryNonce, setRetryNonce] = useState(0)
  const dataRef = useRef<DataState>({ events: [], stages: [] })
  const platformRef = useRef<LifePlatform | null>(null)
  const queueRef = useRef<RevisionedSaveQueue | null>(null)
  const flushRef = useRef<() => Promise<void>>(async () => undefined)
  const closeDisposeRef = useRef<(() => void) | null>(null)
  const preferencesDisposeRef = useRef<(() => void) | null>(null)
  const preferenceErrorDisposeRef = useRef<(() => void) | null>(null)
  const metaRef = useRef<Record<string, unknown>>({})

  useEffect(() => {
    let cancelled = false
    const platform = createLifePlatform({ events: MOCK_LIFE_EVENTS, stages: MOCK_LIFE_STAGES })
    platformRef.current = platform
    setPlatformKind(platform.kind)
    setHasLoadedLibrary(false)
    setPersistenceStatus('loading')
    setPersistenceError(null)

    const run = async () => {
      try {
        const loaded = await platform.loadSnapshot()
        if (cancelled) return
        const next = { events: sortEventsByDate(loaded.snapshot.events), stages: sortStages(loaded.snapshot.stages) }
        metaRef.current = loaded.snapshot.meta ? { ...loaded.snapshot.meta } : {}
        const preferences = metaRef.current.preferences
        const schedulePreferences = preferences as Record<string, unknown> | undefined
        setSchedules(Array.isArray(schedulePreferences?.[SCHEDULE_KEY]) ? (schedulePreferences[SCHEDULE_KEY] as unknown[]).map(validateSource) : [])
        setScheduleUndo((schedulePreferences?.[UNDO_KEY] as ScheduleUndo | null) ?? null)
        setInitialPreferences(preferences && typeof preferences === 'object' && !Array.isArray(preferences) ? preferences as Preferences : {})
        dataRef.current = next
        setEvents(next.events)
        setStages(next.stages)
        const queue = new RevisionedSaveQueue({
          adapter: platform,
          initialRevision: loaded.revision,
          onStateChange: (state: SaveQueueState) => {
            if (cancelled) return
            if (state.status === 'error') {
              setPersistenceStatus('error')
              setPersistenceError(state.error ?? '本地保存失败。')
            } else if (state.status === 'saving' || state.status === 'scheduled') {
              setPersistenceStatus('saving')
              setPersistenceError(null)
            } else if (state.status === 'saved') {
              setPersistenceStatus('saved')
              setPersistenceError(null)
            } else {
              setPersistenceStatus('ready')
            }
          },
        })
        queueRef.current = queue

        // The native repository returns attachment metadata as part of the
        // snapshot.  Hydrate it before the first desktop paint so existing
        // image/attachment nodes can resolve controlled asset URLs after a
        // cold start.  Browser mode implements this as a no-op.
        const attachmentRecords = Array.isArray(metaRef.current.attachments)
          ? metaRef.current.attachments as DesktopAttachmentRecord[]
          : []
        await hydrateAttachments(attachmentRecords)
        if (cancelled) return

        // Preference edits are part of the same revisioned snapshot as life
        // events.  This prevents a display-setting write from racing an
        // event write and accidentally replacing the snapshot metadata.
        preferencesDisposeRef.current = registerDesktopPreferencePersistence({
          save: async (patch: Preferences) => {
            const currentMeta = metaRef.current
            const currentPreferences = currentMeta.preferences && typeof currentMeta.preferences === 'object' && !Array.isArray(currentMeta.preferences)
              ? currentMeta.preferences as Record<string, unknown>
              : {}
            metaRef.current = {
              ...currentMeta,
              preferences: { ...currentPreferences, ...patch },
            }
            const current = queue.getState()
            queue.enqueue(makeSnapshot(dataRef.current.events, dataRef.current.stages, current.revision, metaRef.current))
          },
        })
        preferenceErrorDisposeRef.current = subscribeDesktopPreferenceErrors((error) => {
          if (cancelled) return
          setPersistenceStatus('error')
          setPersistenceError(error instanceof Error ? error.message : '本地偏好设置保存失败。')
        })
        flushRef.current = async () => {
          await runBeforePersistenceFlush()
          await queue.flush()
          await platform.flush(queue.getState().lastSavedRevision)
        }
        closeDisposeRef.current = platform.registerCloseHandler?.(flushRef.current, (error) => {
          if (cancelled) return
          setPersistenceStatus('error')
          setPersistenceError(error.message)
        }) ?? null
        // Automatic-backup diagnostics are exposed through the independent
        // backup-status event stream. They must never turn a successful
        // snapshot load into a persistence error or block an empty library.
        setHasLoadedLibrary(true)
        setPersistenceStatus('ready')
        setPersistenceError(null)
      } catch (error) {
        if (cancelled) return
        setPersistenceStatus('error')
        setPersistenceError(error instanceof Error ? error.message : '无法打开本机资料库。')
      }
    }
    void run()
    // A renderer reload/close invalidates the WebView-owned Tauri callback
    // table.  Starting a second async flush from beforeunload can therefore
    // surface `runCallback` errors and race the native save already completed
    // by an explicit action or the close handler.  Mark teardown here; normal
    // native close/background paths have their own awaited flush barrier.
    const unload = () => { markPageUnloading() }
    if (typeof window !== 'undefined') window.addEventListener('beforeunload', unload)
    return () => {
      cancelled = true
      if (typeof window !== 'undefined') window.removeEventListener('beforeunload', unload)
      closeDisposeRef.current?.()
      closeDisposeRef.current = null
      preferencesDisposeRef.current?.()
      preferencesDisposeRef.current = null
      preferenceErrorDisposeRef.current?.()
      preferenceErrorDisposeRef.current = null
      const queue = queueRef.current
      const platformToDispose = platformRef.current
      // A page teardown cannot safely await another Tauri IPC call.  The
      // explicit import/restore/rollback flows flush before reloading, while
      // native close and Android backgrounding flush through their dedicated
      // lifecycle handlers.  Only ordinary in-document effect resets need the
      // best-effort unmount flush.
      const rendererIsTearingDown = isPageUnloading()
        || (typeof document !== 'undefined' && document.visibilityState === 'hidden')
      if (rendererIsTearingDown) {
        queue?.dispose()
        platformToDispose?.dispose?.()
      } else {
        void flushRef.current().finally(() => {
          queue?.dispose()
          platformToDispose?.dispose?.()
        })
      }
      queueRef.current = null
      platformRef.current = null
    }
  }, [retryNonce])

  const enqueue = useCallback((next: DataState) => {
    dataRef.current = next
    setEvents(next.events)
    setStages(next.stages)
    const queue = queueRef.current
    if (!queue) return
    const current = queue.getState()
    const snapshot: LifeSnapshot = makeSnapshot(next.events, next.stages, current.revision, metaRef.current)
    try {
      queue.enqueue(snapshot)
    } catch (error) {
      setPersistenceStatus('error')
      setPersistenceError(error instanceof Error ? error.message : '本地保存失败。')
    }
  }, [])

  const selectEvent = useCallback((id: string | null) => setSelectedId(id), [])
  const saveSchedules = useCallback((sources: ScheduleSource[], undo?: ScheduleUndo | null, nextEvents?: LifeEvent[]) => {
    const validated = sources.map(validateSource)
    const preferences = { ...(metaRef.current.preferences as Record<string, unknown> ?? {}), [SCHEDULE_KEY]: validated, ...(undo !== undefined ? { [UNDO_KEY]: undo } : {}) }
    metaRef.current = { ...metaRef.current, preferences }
    setSchedules(validated)
    if (undo !== undefined) setScheduleUndo(undo)
    enqueue({ ...dataRef.current, ...(nextEvents ? { events: nextEvents } : {}) })
  }, [enqueue])
  const getEvents = useCallback(() => dataRef.current.events, [])
  const updateEvent = useCallback((id: string, patch: Partial<LifeEvent>) => {
    const next = patchEventInDateOrder(dataRef.current.events, id, patch)
    if (next !== dataRef.current.events) enqueue({ events: next, stages: dataRef.current.stages })
  }, [enqueue])
  const createEvent = useCallback((event: Omit<LifeEvent, 'id'>) => {
    const id = `event-${Date.now()}`
    enqueue({ events: sortEventsByDate([...dataRef.current.events, { ...event, id }]), stages: dataRef.current.stages })
    setSelectedId(id)
    return id
  }, [enqueue])
  const findDailyEntry = useCallback((dateKey: string) => dataRef.current.events.find((event) => isDailyEntry(event) && event.date === dateKey) ?? null, [])
  const createDailyEntry = useCallback((dateKey: string, draft?: Partial<LifeEvent>) => {
    const existing = findDailyEntry(dateKey)
    if (existing) {
      if (draft) enqueue({ events: sortEventsByDate(dataRef.current.events.map((event) => event.id === existing.id ? { ...event, ...draft, id: existing.id } : event)), stages: dataRef.current.stages })
      setSelectedId(existing.id)
      return existing.id
    }
    const baseId = draft?.id ?? `daily-${dateKey}`
    // A diary can move to another day while keeping its identity. Writing on
    // its original day again must create a different record, not reuse that id.
    const id = dataRef.current.events.some((event) => event.id === baseId)
      ? `${baseId}-${crypto.randomUUID()}`
      : baseId
    const entry: LifeEvent = { ...makeDailyEntry(dateKey), ...draft, id, type: 'daily', date: dateKey }
    enqueue({ events: sortEventsByDate([...dataRef.current.events, entry]), stages: dataRef.current.stages })
    setSelectedId(id)
    return id
  }, [enqueue, findDailyEntry])
  const pickStage = useCallback((id: string) => { setActiveStageId(id); setPickedStageId(id === ALL_STAGE_ID ? null : id) }, [])
  const createStage = useCallback((stage: Omit<LifeStage, 'id'>) => {
    const id = `stage-${Date.now()}`
    enqueue({ events: dataRef.current.events, stages: sortStages([...dataRef.current.stages, { ...stage, id }]) })
    return id
  }, [enqueue])
  const updateStage = useCallback((id: string, patch: Partial<LifeStage>) => enqueue({ events: dataRef.current.events, stages: sortStages(dataRef.current.stages.map((stage) => stage.id === id ? { ...stage, ...patch, id } : stage)) }), [enqueue])
  const deleteStage = useCallback((id: string) => {
    enqueue({ events: dataRef.current.events.map((event) => event.stageId === id ? { ...event, stageId: null } : event), stages: dataRef.current.stages.filter((stage) => stage.id !== id) })
    setActiveStageId((current) => current === id ? ALL_STAGE_ID : current)
    setPickedStageId((current) => current === id ? null : current)
  }, [enqueue])
  const getStageById = useCallback((id: string | null) => id ? stages.find((stage) => stage.id === id) ?? null : null, [stages])
  const flushPersistence = useCallback(async () => {
    try { await flushRef.current(); setPersistenceStatus('saved'); setPersistenceError(null) }
    catch (error) { setPersistenceStatus('error'); setPersistenceError(error instanceof Error ? error.message : '本地保存失败。'); throw error }
  }, [])
  const retryPersistence = useCallback(() => {
    // Once a queue exists, retry its retained immutable snapshot.  Recreating
    // the provider would reload the database and discard edits that have not
    // yet reached disk, which is precisely what the retry action must protect.
    if (queueRef.current) {
      void flushPersistence().catch(() => undefined)
      return
    }
    // A failure during the initial open has no queue to retry yet.
    setRetryNonce((value) => value + 1)
  }, [flushPersistence])
  const registerBeforePersistenceFlushInStore = useCallback(
    (callback: () => Promise<void> | void) => registerBeforePersistenceFlush(callback),
    [],
  )
  const activeStage = useMemo(() => stages.find((stage) => stage.id === activeStageId) ?? null, [stages, activeStageId])
  const value = useMemo<LifeStore>(() => ({ schedules, scheduleUndo, saveSchedules, getEvents, initialPreferences, events, stages, activeStageId, activeStage, pickedStageId, selectedId, persistenceStatus, persistenceError, platformKind, selectEvent, updateEvent, createEvent, findDailyEntry, createDailyEntry, setActiveStageId, pickStage, createStage, updateStage, deleteStage, getStageById, retryPersistence, flushPersistence, registerBeforePersistenceFlush: registerBeforePersistenceFlushInStore }), [schedules, scheduleUndo, saveSchedules, getEvents, initialPreferences, events, stages, activeStageId, activeStage, pickedStageId, selectedId, persistenceStatus, persistenceError, platformKind, selectEvent, updateEvent, createEvent, findDailyEntry, createDailyEntry, pickStage, createStage, updateStage, deleteStage, getStageById, retryPersistence, flushPersistence, registerBeforePersistenceFlushInStore])

  const body = persistenceStatus === 'loading'
    ? <div className="min-h-screen bg-background text-foreground flex items-center justify-center" role="status">正在打开 life-timeline 本机资料库……</div>
    : persistenceStatus === 'error' && !hasLoadedLibrary
      ? <div className="min-h-screen bg-background text-foreground flex flex-col items-center justify-center gap-4 p-8" role="alert"><p>无法打开 life-timeline 本机资料库。</p><p className="text-sm opacity-70">{persistenceError ?? '未知错误'}</p><button type="button" className="rounded border px-4 py-2" onClick={retryPersistence}>重试</button></div>
      : <LifeStoreContext.Provider value={value}>{children}</LifeStoreContext.Provider>
  return <>{body}<SeasonalSplash enabled={showSeasonalSplash} ready={persistenceStatus !== 'loading'} /></>
}

export function useLifeStore(): LifeStore {
  const context = useContext(LifeStoreContext)
  if (!context) throw new Error('useLifeStore 必须在 LifeStoreProvider 内使用')
  return context
}
