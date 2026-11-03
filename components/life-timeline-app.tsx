'use client'

// Life Timeline 顶层组件
//
// 核心模型:这是一个连续的人生空间,不是一组文章页面。
//   横向 = 在时间里前后穿行
//   纵向 = 在"人生全景"与"具体记忆"之间深浅移动
//
// 纵向的"深浅"由一个连续的收缩进度 p ∈ [0,1] 表达,它直接由 window.scrollY 算出:
//   p = 0  大时间轴,浏览一生
//   p = 1  迷你时间轴吸附顶部,正文成为主视觉
// 中间的每一个值都是有效状态 —— 没有阈值切换,因此不存在临界点抖动。
//
// 关键不变量(这套滚动模型能稳定的原因):
//   1. sticky 顶部的**布局高度恒定**。收缩只用 transform / opacity 表达,
//      永远不改 height / margin / padding / top,所以滚动过程中不会发生 reflow。
//   2. 文档高度因此恒定,浏览器不会夹紧 scrollY,不会反过来改变 p。
//   3. 于是 p 只被用户的滚动驱动,单向、无环。

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Settings } from 'lucide-react'
import { useLifeStore } from '@/lib/life-store'
import { dateToDecimalYear, makeDailyEntry, todayKey, type LifeEvent } from '@/types/life-event'
import { docHasSubstance } from '@/lib/rich-content'
import { useAnyOverlayOpen } from '@/lib/overlay-registry'
import type { RichEditorHandle } from '@/components/editor/rich-editor'
import { BackToTop } from '@/components/navigation/back-to-top'
import type { AdjacentRecords } from '@/components/navigation/edge-navigation'
import {
  ALL_STAGE_ID,
  formatStageRange,
  isEventInStage,
  stageAtYear,
  stageRange,
  type LifeStage,
} from '@/types/life-stage'
import {
  LifeTimeline,
  TRACK_HEIGHT,
  type LifeTimelineHandle,
} from '@/components/timeline/life-timeline'
import { LifeStageNav } from '@/components/navigation/life-stage-nav'
import { TimelineEmptyState } from '@/components/event/timeline-empty-state'
import { EventWritingPane } from '@/components/event/event-writing-pane'
import { CreateEventDrawer } from '@/components/event/create-event-drawer'
import { StageEditorDrawer } from '@/components/stage/stage-editor-drawer'
import { TimelineSettingsDrawer } from '@/components/timeline/timeline-settings-drawer'
import { TimelineSettingsProvider, useTimelineSettings } from '@/lib/timeline-settings'
import { TimelineCollapseControl } from '@/components/timeline/timeline-collapse-control'
import { FIXED_TIMELINE_CLIP_BOTTOM } from '@/lib/timeline-ruler-layout'
import { LifeDrawer } from '@/components/navigation/life-drawer'
import { SearchDialog } from '@/components/navigation/search-dialog'
import { EdgeNavigation } from '@/components/navigation/edge-navigation'
import { ThemeToggle } from '@/components/common/theme-toggle'
import { GalleryIcon, HeaderButton, MenuIcon, PhoneComputerIcon, SearchIcon } from '@/components/common/header-icons'
import { GalleryView } from '@/components/gallery/gallery-view'
import { useBackupStatus } from '@/lib/backup-status'
import { DiaryActionMenu } from '@/components/diary/diary-action-menu'
import { DiaryTransferPage, type DiaryTransferMode } from '@/components/diary/diary-transfer-page'
import { consumeDiaryImportReceipt, type DiaryImportReceipt } from '@/components/diary/import-receipt'
import { ApiManagerPage } from '@/components/diary/api-manager-page'
import { ScheduleManager } from '@/components/schedules/schedule-manager'
import { AppUpdateProvider } from '@/components/updates/app-update-provider'
import { MobileRuntime } from '@/components/common/mobile-runtime'
import { PhoneTransferPage } from '@/components/diary/phone-transfer-page'
import { HeaderActions, HeaderActionsToggle } from '@/components/navigation/header-actions'
import { AutomaticThemeNotice } from '@/components/common/automatic-theme-notice'
import { normalizeViewSession, readBrowserViewSession, resolveViewSession } from '@/lib/view-session'
import { useViewSession } from '@/lib/use-view-session'

/* ── 收缩几何 ──────────────────────────────────────────────
   时间轴收缩时视觉上"消失"的高度 D 由三部分组成:
     · 阶段说明块被让出 + 上方留白收窄   LIFT(整组上移)
     · 底部阶段区间条与控件行被裁掉      CLIP_BOTTOM
     · 整条时间轴等比缩小               × (1 − SCALE_MIN)

   然后让「完全收缩所需的滚动距离」恰好等于 D。于是在任意滚动位置 S:
     顶部可见底边 = H − S
     正文首行     = H − S + GAP
   两者间距恒为 GAP —— 过渡全程都不会遮挡,也不会跳变。

   注意这些量全部是常量,不含任何实测尺寸:
   一旦让 D 依赖测量结果,就会出现"量到新尺寸 → 改变收缩距离 →
   改变进度 → 再改布局"的反馈环,那正是此前上下抖动的根源。
   ────────────────────────────────────────────────────────── */
const DESC_BLOCK = 32 // 阶段说明块(mt-3 + h-5)
const PAD_SHRINK = 36 // 时间轴上方留白 40 → 4
const LIFT = DESC_BLOCK + PAD_SHRINK // 时间轴组整体上移的距离
const CLIP_BOTTOM = FIXED_TIMELINE_CLIP_BOTTOM // 与时间尺共同预留年份文字的完整高度
const SCALE_MIN = 0.82 // 写作状态下时间轴的缩放比 —— 肉眼可辨的 18%
const BLOCK_H = 40 + TRACK_HEIGHT + 16 + 42 // 时间轴块布局高度(pt-10 + 轨道 + pb-4 + 控件行)
const HEADER_FALLBACK = 480 // 首帧测量完成前的兜底高度
// 首帧测量未完成时的安全下限。实际收起高度会由“全部”阶段行的边界计算，
// 不再用 H - collapseDistance 推导，否则顶部收起时会把整段时间轴余量留在正文前。
const COLLAPSED_WRITING_GAP = 70
const COLLAPSED_BOUNDARY_GAP = 8

/* 端点稳定带:进度在两端各留 5% 的余量并重新归一化。
   于是 p < 0.05 稳定为 0、p > 0.95 稳定为 1,滚动停下后不再有肉眼可见的漂移,
   而且因为是线性重映射,过程依然连续 —— 端点不会出现台阶。 */
const EDGE = 0.05

// 供 EdgeNavigation 使用的粗粒度状态。带回差,避免在边界反复通知子组件。
// 注意:它只影响覆盖层的显示与命中区域,绝不参与任何布局计算。
const FOCUS_ENTER_P = 0.62
const FOCUS_EXIT_P = 0.32

export function LifeTimelineApp() {
  return (
    <AppUpdateProvider>
      <MobileRuntime />
      <TimelineSettingsProvider>
        <LifeTimelineAppInner />
      </TimelineSettingsProvider>
    </AppUpdateProvider>
  )
}

function LifeTimelineAppInner() {
  const store = useLifeStore()
  const { events, stages, activeStageId, activeStage, pickedStageId, selectedId, persistenceStatus, persistenceError, registerBeforePersistenceFlush, selectEvent, pickStage, setActiveStageId, findDailyEntry } = store
  const { settings: timelineDisplaySettings, setTimelineCollapsed } = useTimelineSettings()
  const [initialSession] = useState(() => store.platformKind === 'desktop'
    ? normalizeViewSession(store.initialPreferences.viewSession) : readBrowserViewSession())
  const [restoration] = useState(() => resolveViewSession(initialSession, events))
  const [sessionReady, setSessionReady] = useState(false)
  const backupStatus = useBackupStatus()

  const timelineRef = useRef<LifeTimelineHandle>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [galleryOpen, setGalleryOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [headerActionsCollapsed, setHeaderActionsCollapsed] = useState(initialSession?.headerCollapsed ?? false)
  const [createOpen, setCreateOpen] = useState(false)
  const [diaryTransferMode, setDiaryTransferMode] = useState<DiaryTransferMode | null>(null)
  const [diaryImportReceipt, setDiaryImportReceipt] = useState<DiaryImportReceipt | null>(null)
  const [apiManagerOpen, setApiManagerOpen] = useState(false)
  const [scheduleManagerOpen, setScheduleManagerOpen] = useState(false)
  const [phoneTransferOpen, setPhoneTransferOpen] = useState(false)
  const [phoneReceivedArchive, setPhoneReceivedArchive] = useState<string | null>(null)
  const [managingStages, setManagingStages] = useState(false)
  // null = 新建阶段;LifeStage = 编辑该阶段;undefined = 面板关闭
  const [stageDraft, setStageDraft] = useState<LifeStage | null | undefined>(undefined)

  useEffect(() => {
    const receipt = consumeDiaryImportReceipt()
    if (!receipt) return
    setDiaryImportReceipt(receipt)
    setDiaryTransferMode('import')
  }, [])

  /* ── 今日记草稿(§3-§5)
     点「现在」不等于创建记录:今天还没有日记时,先给出一篇不存在于 events 里的
     草稿。它不进目录、不进搜索、不参与左右穿行,因此连续点十次「现在」也只有
     这一份草稿,不会在时间轴上留下一串空白日记。
     只有真正写下第一个非空字符,它才落地成为一条人生记录。 */
  const [draft, setDraft] = useState<LifeEvent | null>(() => restoration.draft ? {
    ...makeDailyEntry(restoration.draft.date), ...restoration.draft, id: `draft-${crypto.randomUUID()}`,
  } : null)
  const [draftAutoFocus, setDraftAutoFocus] = useState(false)
  /* 草稿的同步镜像:编辑回调可能在下一次渲染之前连续到达,必须读到最新草稿,
     否则会出现“已落地却又按草稿再建一次”的竞态 */
  const draftRef = useRef<LifeEvent | null>(draft)
  /** 最近一次草稿落地成的真实记录 id;迟到的编辑回调据此写入正确的那篇 */
  const landedIdRef = useRef<string | null>(null)

  const clearDraft = useCallback(() => {
    draftRef.current = null
    setDraft(null)
  }, [])

  const selectedEvent = useMemo(
    () => events.find((e) => e.id === selectedId) ?? null,
    [events, selectedId],
  )

  // 正文区当前展示的对象:已选中的真实记录优先,其次才是今日草稿
  const writingTarget = selectedEvent ?? draft
  /* 正文文档身份。草稿预先分配独立 id,落地时复用,
     所以草稿 → 今日记时 docKey 不变,编辑器、选区与输入法状态都不会重建 */
  const writingDocKey = selectedEvent
    ? selectedEvent.id
    : draft
      ? draft.id
      : null
  const timelineCollapsed = writingTarget !== null && timelineDisplaySettings.timelineCollapsed
  const writingEditorRef = useRef<RichEditorHandle>(null)
  // Native close and backup commands wait for any IME/composition work still
  // owned by the rich editor before the revisioned store queue is flushed.
  useEffect(
    () => registerBeforePersistenceFlush(() => writingEditorRef.current?.settle()),
    [registerBeforePersistenceFlush],
  )
  const overlayOpen = useAnyOverlayOpen()

  /* ── 尺寸测量 ────────────────────────────────────────────
     这两个高度都与收缩进度无关(进度只施加 transform / opacity),
     因此测量结果是稳定常量,不会形成"改布局 → 重新测量 → 再改布局"的环。
     内容层用 absolute 定位,从根上保证它无法反向决定容器高度。
     ──────────────────────────────────────────────────────── */
  const innerRef = useRef<HTMLDivElement>(null)
  const pageRootRef = useRef<HTMLDivElement>(null)
  const stageBoundaryRef = useRef<HTMLDivElement>(null)
  const [headerHeight, setHeaderHeight] = useState(0)
  const [collapsedFlowHeight, setCollapsedFlowHeight] = useState(COLLAPSED_WRITING_GAP)

  useLayoutEffect(() => {
    store.selectEvent(restoration.selectedId)
    if (!restoration.newDay && initialSession?.pickedStageId && stages.some((stage) => stage.id === initialSession.pickedStageId)) store.pickStage(initialSession.pickedStageId)
    // Native/browser scroll restoration must not compete with our dated state.
    const old = history.scrollRestoration
    history.scrollRestoration = 'manual'
    return () => { history.scrollRestoration = old }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one bootstrap per loaded library
  }, [])

  useEffect(() => {
    let stopped = false
    let frame = 0
    let stableFrames = 0
    let previousHeight = -1
    const start = performance.now()
    const restore = () => {
      if (stopped) return
      const height = document.documentElement.scrollHeight
      stableFrames = height === previousHeight ? stableFrames + 1 : 0
      previousHeight = height
      // Let restored collapses, fonts and the editor establish real dimensions.
      if ((stableFrames >= 3 && timelineRef.current?.getViewportCenter() !== null && document.fonts.status === 'loaded') || performance.now() - start > 1600) {
        window.scrollTo({ top: restoration.scrollY, behavior: 'instant' })
        setSessionReady(true)
        return
      }
      frame = requestAnimationFrame(restore)
    }
    frame = requestAnimationFrame(restore)
    return () => { stopped = true; cancelAnimationFrame(frame) }
  }, [restoration.scrollY])

  useLayoutEffect(() => {
    const inner = innerRef.current
    if (!inner) return

    // 首帧同步量一次,避免测量前后出现一次可见的跳动
    const measure = () => setHeaderHeight(inner.offsetHeight)
    measure()

    const observer = new ResizeObserver(measure)
    observer.observe(inner)
    return () => observer.disconnect()
  }, [])

  // 收起时正文应紧跟“释放”控制。阶段行位于 absolute 内容层中，不能依靠
  // 正常流自动撑开 sticky 容器，因此量取它相对内容层的底边作为唯一锚点。
  // 这个测量与时间轴滚动进度无关，不会形成布局反馈环；窗口尺寸或顶部功能
  // 收纳变化时 ResizeObserver 会重新计算。
  useLayoutEffect(() => {
    const boundary = stageBoundaryRef.current
    const inner = innerRef.current
    if (!boundary || !inner) return
    const measure = () => {
      const innerTop = inner.getBoundingClientRect().top
      const control = boundary.querySelector<HTMLElement>('[data-timeline-collapse-control="stage"]')
      // The release rule is absolutely positioned just below the stage row.
      // Measure the rule itself once it exists; before the first collapsed
      // render, reserve its fixed 24px control height as a safe fallback.
      const box = control?.getBoundingClientRect() ?? boundary.getBoundingClientRect()
      const bottom = box.bottom - innerTop + (control ? 0 : 24)
      setCollapsedFlowHeight(Math.max(COLLAPSED_WRITING_GAP, Math.ceil(bottom + COLLAPSED_BOUNDARY_GAP)))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(boundary)
    if (innerRef.current) observer.observe(innerRef.current)
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [headerActionsCollapsed, timelineCollapsed])

  const H = headerHeight || HEADER_FALLBACK

  /*
    完全收缩所需的滚动距离,同时也正是视觉上收缩掉的总高度。
    先算出裁切并缩放之后时间轴块真正还占多高,差额即为它让出的空间。
  */
  const collapseDistance = LIFT + (BLOCK_H - (BLOCK_H - CLIP_BOTTOM) * SCALE_MIN)

  /* ── 连续进度驱动 ────────────────────────────────────────
     每帧只往 DOM 写一个自定义属性,由 CSS calc() 完成插值 ——
     不触发 React 重渲染,transform 与 opacity 都在合成层完成。
     ─────────────────────────────────────────────��────────── */
  const [focused, setFocused] = useState(false)
  const focusedRef = useRef(false)
  const rafRef = useRef<number | null>(null)
  /** 最近一次写入的收拢进度。只供覆盖层的感应范围读取,绝不回写任何布局 */
  const progressRef = useRef(0)

  useEffect(() => {
    /*
      进度写在 documentElement 上,而不是某个局部容器:
      顶部时间轴与下方正文是兄弟节点,都要读同一个进度来完成视觉交接。
    */
    const root = pageRootRef.current
    if (!root) return

    const apply = () => {
      rafRef.current = null
      const raw = window.scrollY / collapseDistance
      // 端点各留 5% 余量后重新归一化:两端彻底稳定,中间仍然连续
      const p = Math.min(1, Math.max(0, (raw - EDGE) / (1 - EDGE * 2)))
      root.style.setProperty('--tl-p', p.toFixed(4))
      progressRef.current = p

      // 回差：进入与退出用不同的门槛，子组件不应在边界被反复通知
      const next = focusedRef.current ? p > FOCUS_EXIT_P : p > FOCUS_ENTER_P
      if (next !== focusedRef.current) {
        focusedRef.current = next
        setFocused(next)
      }
    }

    const onScroll = () => {
      if (rafRef.current !== null) return
      rafRef.current = requestAnimationFrame(apply)
    }

    apply()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    }
  }, [collapseDistance])

  // 只有正文真正存在(已选中的记录,或今天的草稿),纵向才有"深浅"可言
  const focusMode = focused && writingTarget !== null
  const selectedEventId = selectedEvent?.id ?? null
  const selectedEventDate = selectedEvent?.date ?? null

  // 日期确认后事件会按新日期重新排序。时间轴视觉层在收起状态下是隐藏的，
  // 因此显式把同一节点重新定位，避免正文已经换日期而横轴仍停在旧位置。
  const previousSelectedDate = useRef({ id: selectedEventId, date: selectedEventDate })
  useEffect(() => {
    const previous = previousSelectedDate.current
    previousSelectedDate.current = { id: selectedEventId, date: selectedEventDate }
    if (!focusMode || !selectedEventId || !selectedEventDate || previous.id !== selectedEventId || previous.date === selectedEventDate) return
    const frame = requestAnimationFrame(() => timelineRef.current?.scrollToEvent(selectedEventId, false))
    return () => cancelAnimationFrame(frame)
  }, [focusMode, selectedEventDate, selectedEventId])

  const collapseTimeline = useCallback(() => {
    if (!writingTarget) return
    // 收起会把顶部 sticky 容器从 H 压到阶段行边界。补偿这段被移除的
    // 流高度，保持用户正在阅读的正文位置；在顶部路径自然夹到 0，
    // 日期与释放线会紧邻而不会留下旧时间轴的空白。
    const beforeCollapseY = window.scrollY
    const removedFlow = Math.max(0, H - collapsedFlowHeight)
    setTimelineCollapsed(true)
    requestAnimationFrame(() => {
      window.scrollTo({ top: Math.max(0, beforeCollapseY - removedFlow), behavior: 'smooth' })
    })
  }, [H, collapsedFlowHeight, setTimelineCollapsed, writingTarget])

  const releaseTimeline = useCallback(() => {
    setTimelineCollapsed(false)
  }, [setTimelineCollapsed])

  /* ── 左右穿行的目标 ─────────────────────────────────────
     Daily 与 Event 共同组成一条时间序列(events 已按时间稳定排序),
     与屏幕位置、DOM 顺序、当前阶段、标签是否被隐藏都无关。
     目标在点击那一刻按最新状态计算,因此连续点击不会用到过期索引。 */
  const centerYearRef = useRef<number | null>(null)
  const navRef = useRef({ events, selectedId, draft })
  useLayoutEffect(() => {
    navRef.current = { events, selectedId, draft }
  }, [events, selectedId, draft])

  const resolveAdjacent = useCallback((): AdjacentRecords => {
    const { events: list, selectedId: currentId, draft: currentDraft } = navRef.current
    const index = currentId ? list.findIndex((e) => e.id === currentId) : -1
    if (index >= 0) {
      return { prev: list[index - 1] ?? null, next: list[index + 1] ?? null }
    }
    // 没有选中真实记录:今日草稿以今天为锚点,首页总览以时间轴视口中心为锚点
    const anchor = currentDraft
      ? dateToDecimalYear(currentDraft.date)
      : (centerYearRef.current ?? dateToDecimalYear(todayKey()))
    let prev: LifeEvent | null = null
    let next: LifeEvent | null = null
    for (const e of list) {
      if (dateToDecimalYear(e.date) <= anchor) prev = e
      else {
        next = e
        break
      }
    }
    return { prev, next }
  }, [])

  // 顶部区域当前可见下边界 = H − 收缩距离 × 进度(与正文首行的定位同一套几何)
  const geometryRef = useRef({ H, collapseDistance })
  useLayoutEffect(() => {
    geometryRef.current = { H, collapseDistance }
  }, [H, collapseDistance])
  const getTopBoundary = useCallback(() => {
    const { H: height, collapseDistance: distance } = geometryRef.current
    return height - distance * progressRef.current
  }, [])

  // 当前事件所属阶段:显式绑定优先,否则按时间落入
  const selectedEventStage = useMemo(() => {
    if (!writingTarget) return null
    return stages.find((s) => isEventInStage(writingTarget, s)) ?? null
  }, [writingTarget, stages])

  // 各阶段范围内的事件数量,用于弱化空阶段
  const stageCounts = useMemo(() => {
    const map = new Map<string, number>()
    for (const stage of stages) {
      map.set(stage.id, events.filter((e) => isEventInStage(e, stage)).length)
    }
    return map
  }, [events, stages])

  // 点击阶段 = 快速定位:把完整时间轴平滑移动到该阶段所在的时间段,不做任何筛选
  const handleSelectStage = useCallback(
    (id: string) => {
      pickStage(id)
      if (id === ALL_STAGE_ID) {
        // 「全部」= 缩放并居中,让整个人生跨度回到窗口内
        requestAnimationFrame(() => timelineRef.current?.fitAll())
        return
      }
      const stage = stages.find((s) => s.id === id)
      if (!stage) return
      const { start, end } = stageRange(stage)
      requestAnimationFrame(() => timelineRef.current?.scrollToRange(start, end))
    },
    [pickStage, stages],
  )

  // 反向联动:拖动 / 缩放时间轴 → 按视口中心时间判断当前处于哪个人生阶段
  const handleViewportCenterChange = useCallback(
    (centerYear: number, coversWholeLife: boolean) => {
      centerYearRef.current = centerYear
      if (coversWholeLife) {
        setActiveStageId(ALL_STAGE_ID)
        return
      }
      const stage = stageAtYear(stages, centerYear, pickedStageId)
      setActiveStageId(stage ? stage.id : ALL_STAGE_ID)
    },
    [setActiveStageId, stages, pickedStageId],
  )

  /**
   * 正文挂载后做一次平滑定位 —— 这是整个应用里唯一一处纵向滚动写入。
   * 收缩动作本身不在这里发生:它完全由滚动进度自然产生。
   */
  const scrollIntoWriting = useCallback(() => {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (window.scrollY >= collapseDistance - 1) return
        window.scrollTo({ top: collapseDistance, behavior: 'smooth' })
      }),
    )
  }, [collapseDistance])

  // 点击时间轴节点:只做两件事 —— 选中,然后定位一次
  const handleSelectNode = useCallback(
    (id: string) => {
      clearDraft()
      selectEvent(id)
      scrollIntoWriting()
    },
    [selectEvent, clearDraft, scrollIntoWriting],
  )

  /* ── 「现在」= 定位今天 + 直接开始写今天(§1-§2)
     不跳路由、不开 Modal、不开新建节点 Drawer:记录今天不该先填表格。
     今天已有日记 → 直接载入原文继续写(不问"是否打开");
     今天还没有 → 给一篇草稿,时间轴上先由 Today Cursor 说明"我在这里"。
     全程只改视口位置,用户的长度 / 宽度倍率与主题一概不动(§12)。 */
  const handleGoToNow = useCallback(() => {
    setDraftAutoFocus(true)
    const key = todayKey()
    timelineRef.current?.scrollToDate(key)
    const existing = findDailyEntry(key)
    if (existing) {
      clearDraft()
      selectEvent(existing.id)
    } else {
      selectEvent(null)
      const nextDraft = draftRef.current?.date === key ? draftRef.current : { ...makeDailyEntry(key), id: `daily-${key}-${crypto.randomUUID()}` }
      draftRef.current = nextDraft
      landedIdRef.current = null
      setDraft(nextDraft)
    }
    scrollIntoWriting()
  }, [findDailyEntry, selectEvent, clearDraft, scrollIntoWriting])

  useViewSession({
    ready: sessionReady,
    desktop: store.platformKind === 'desktop',
    capture: () => ({
      selectedId,
      draft: !selectedId && draftRef.current ? { date: draftRef.current.date, title: draftRef.current.title, importance: draftRef.current.importance } : null,
      scrollY: window.scrollY,
      timelineCenter: timelineRef.current?.getViewportCenter() ?? null,
      pickedStageId,
      headerCollapsed: headerActionsCollapsed,
    }),
    flush: store.flushPersistence,
    openToday: () => {
      const key = todayKey()
      const existing = store.findDailyEntry(key)
      clearDraft()
      store.selectEvent(existing?.id ?? null)
      setDraftAutoFocus(false)
      if (!existing) {
        const next = { ...makeDailyEntry(key), id: `daily-${key}-${crypto.randomUUID()}` }
        draftRef.current = next
        landedIdRef.current = null
        setDraft(next)
      }
      timelineRef.current?.scrollToDate(key, false)
      window.scrollTo({ top: 0, behavior: 'instant' })
    },
  })

  /* 草稿编辑:正文第一次出现实质内容的那一刻才真正建档(§4)。
     实质内容 = 非空白文字,或至少一张成功插入的图片 / 一个附件。
     标题 / 时间 / 重要程度的修改在落地前只留在草稿里 —— 改标题不算"开始写"。 */
  const handleDraftChange = useCallback(
    (patch: Partial<LifeEvent>) => {
      const current = draftRef.current
      if (!current) {
        // 草稿已经落地,但编辑回调迟到了一拍:写进落地后的那一篇,绝不再建一篇
        if (landedIdRef.current) store.updateEvent(landedIdRef.current, patch)
        return
      }
      const next = { ...current, ...patch, id: current.id }
      const substantive = next.richContent
        ? docHasSubstance(next.richContent.doc)
        : next.content.trim() !== ''
      if (!substantive) {
        draftRef.current = next
        setDraft(next)
        return
      }
      // 落地:草稿连同已修改过的标题等一起成为真实记录,并接管选中状态
      const realId = store.createDailyEntry(next.date, next)
      landedIdRef.current = realId
      clearDraft()
      // 时间轴上今天从 Today Cursor 换成真实日刻度,顺势对齐(不改缩放)
      requestAnimationFrame(() => timelineRef.current?.scrollToEvent(realId, false))
    },
    [store, clearDraft],
  )

  /* 左右穿行:点击边缘按钮才触发。
     先让输入法安全结束合成(最后一个字写回当前这篇),再换记录;
     横向把时间轴移到目标,纵向一次定位到正文起点 —— 不是回到页面顶部,
     也不会停在上一篇长文的末尾留下空白。 */
  const navigatingRef = useRef(false)
  const handleEdgeNavigate = useCallback(
    async (id: string) => {
      if (navigatingRef.current) return
      navigatingRef.current = true
      try {
        await writingEditorRef.current?.settle()
        navRef.current = { ...navRef.current, selectedId: id, draft: null }
        clearDraft()
        store.selectEvent(id)
        timelineRef.current?.scrollToEvent(id)
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const y = window.scrollY
            if (y > collapseDistance + 1) {
              window.scrollTo({ top: collapseDistance, behavior: 'instant' })
            } else if (y < collapseDistance - 1) {
              window.scrollTo({ top: collapseDistance, behavior: 'smooth' })
            }
          }),
        )
      } finally {
        navigatingRef.current = false
      }
    },
    [store, clearDraft, collapseDistance],
  )

  // 目录 / 搜索跳转:选中并把时间轴移到该节点,同时进入书写状态
  const handleJumpToEvent = useCallback(
    (id: string) => {
      clearDraft()
      store.selectEvent(id)
      timelineRef.current?.scrollToEvent(id, false)
      scrollIntoWriting()
    },
    [store, clearDraft, scrollIntoWriting],
  )

  /* 图集 →「回到原文」:换到那一篇,等它的正文渲染出这张图 / 这段媒体,
     再把它滚到收拢后顶部时间轴的下方,并短暂描一圈边,让眼睛知道“就是这里”。 */
  const handleRevealMedia = useCallback(
    async (eventId: string, attachmentId: string) => {
      setGalleryOpen(false)
      await writingEditorRef.current?.settle()
      navRef.current = { ...navRef.current, selectedId: eventId, draft: null }
      clearDraft()
      store.selectEvent(eventId)
      timelineRef.current?.scrollToEvent(eventId, false)

      const selector = `.lt-editor [data-gallery-id="${CSS.escape(attachmentId)}"]`
      let tries = 0
      const locate = () => {
        const el = document.querySelector<HTMLElement>(selector)
        if (!el) {
          // 正文还没换好就再等一帧;实在找不到(文件已被移除)就退回到正文开头
          if (++tries < 90) requestAnimationFrame(locate)
          else scrollIntoWriting()
          return
        }
        const { H: height, collapseDistance: distance } = geometryRef.current
        const inset = height - distance
        const target = el.getBoundingClientRect().top + window.scrollY - inset - 96
        window.scrollTo({ top: Math.max(distance, target), behavior: 'smooth' })
        el.classList.remove('lt-reveal')
        void el.offsetWidth
        el.classList.add('lt-reveal')
        window.setTimeout(() => el.classList.remove('lt-reveal'), 2600)
      }
      requestAnimationFrame(locate)
    },
    [store, clearDraft, scrollIntoWriting],
  )

  const handleCreateEvent = useCallback(
    (event: Omit<LifeEvent, 'id'>) => {
      clearDraft()
      const id = store.createEvent(event)
      requestAnimationFrame(() => timelineRef.current?.scrollToEvent(id))
      scrollIntoWriting()
    },
    [store, clearDraft, scrollIntoWriting],
  )

  /* 文件拖到正文以外的地方时,阻止浏览器“打开这个文件”离开页面 ——
     那会让本次会话里的全部记录与附件瞬间丢失。只拦截文件拖放,不影响其他拖拽。 */
  useEffect(() => {
    const carriesFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files')
    const onDragOver = (e: DragEvent) => {
      if (!carriesFiles(e)) return
      e.preventDefault()
      const inEditor = (e.target as Element | null)?.closest?.('.ProseMirror')
      if (!inEditor && e.dataTransfer) e.dataTransfer.dropEffect = 'none'
    }
    const onDrop = (e: DragEvent) => {
      if (carriesFiles(e)) e.preventDefault()
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  // 创建 / 保存阶段:创建后自动选中并聚焦该阶段
  const handleSubmitStage = useCallback(
    (value: Omit<LifeStage, 'id'>) => {
      if (stageDraft) {
        store.updateStage(stageDraft.id, value)
      } else {
        const id = store.createStage(value)
        store.pickStage(id)
        setManagingStages(false)
        const { start, end } = stageRange({ ...value, id })
        requestAnimationFrame(() => timelineRef.current?.scrollToRange(start, end))
      }
    },
    [store, stageDraft],
  )

  return (
    <div ref={pageRootRef} data-life-timeline-root data-session-ready={sessionReady} style={{ visibility: sessionReady ? 'visible' : 'hidden' }} className="min-h-svh bg-background text-foreground">
      <AutomaticThemeNotice />
      {persistenceStatus === 'error' && persistenceError && (
        <div className="pointer-events-auto fixed inset-x-0 top-0 z-50 flex justify-center px-4 pt-3" role="alert">
          <div className="max-w-2xl rounded border border-destructive/30 bg-background/95 px-4 py-2 text-xs text-destructive shadow-sm backdrop-blur">
            {persistenceError}
          </div>
        </div>
      )}
      {backupStatus?.status === 'error' && (
        <div className="pointer-events-auto fixed inset-x-0 top-11 z-50 flex justify-center px-4 pt-2" role="alert" aria-live="assertive">
          <div className="max-w-2xl rounded border border-destructive/30 bg-background/95 px-4 py-2 text-xs text-destructive shadow-sm backdrop-blur">
            自动备份失败：{backupStatus.error ?? '本次自动备份未完成。'}
          </div>
        </div>
      )}
      {/*
        顶部区域:顶栏 + 人生阶段 + 时间轴。
        展开时容器的布局高度为 H,内容层 absolute 覆盖其上 ——
        滚动时只有 transform 在变,页面不会因连续收缩而抖动；
        用户明确收起后才把已释放的高度从正常流中移除。
        容器本身不接收指针事件,好让下方正文在被"腾空"的区域里依然可点。
      */}
      <div
        className="lt-timeline-sticky pointer-events-none sticky top-0 z-30"
        style={{
          // Expanded scrolling still uses the fixed geometry. Once the user
          // explicitly folds the timeline, keep only the measured stage row
          // and its release affordance in normal flow; deriving this from
          // H - collapseDistance leaves a large blank band on Android.
          height: timelineCollapsed ? collapsedFlowHeight : H,
          '--lt-timeline-boundary': `calc((${H} - ${collapseDistance} * var(--tl-p, 0)) * 1px)`,
          '--lt-timeline-boundary-opacity': focusMode && !timelineCollapsed ? '1' : '0',
        } as CSSProperties}
      >
        {/* 背景���：随时间轴自上而下收起，让出的区域露出下方正文 */}
        <div
          aria-hidden="true"
          data-timeline-background=""
          className="absolute inset-x-0 top-0 origin-top bg-background"
          style={{
            // The collapsed stage control is the new boundary.  Keeping the
            // old opaque ruler background at its transformed height would
            // leave a z-30 sheet over the date/title even after the writing
            // pane has moved up.  Remove that sheet completely while folded;
            // the page background then lets the writing pane paint through.
            height: timelineCollapsed ? 0 : H,
            opacity: timelineCollapsed ? 0 : 1,
            transform: `scaleY(calc((${H} - ${collapseDistance} * var(--tl-p, 0)) / ${H}))`,
            willChange: 'transform',
          }}
        />

        {/* 收缩后用一条细线把顶部与正文分开,位置跟着背景底边走 */}
        <div
          aria-hidden="true"
          className="absolute inset-x-0 top-0 h-px bg-border"
          style={{
            transform: `translate3d(0, calc((${H} - ${collapseDistance} * var(--tl-p, 0)) * 1px), 0)`,
            opacity: timelineCollapsed ? 0 : 'var(--tl-p, 0)',
            willChange: 'transform',
          }}
        />

        {focusMode && !timelineCollapsed && (
          <TimelineCollapseControl placement="divider" onClick={collapseTimeline} />
        )}

        {/*
          内容层的布局高度恒为 H,收缩只是 transform —— 它的盒子会一直盖到正文上方。
          因此它自身不接收指针,只让真正可见的顶栏 / 阶段行 / 时间轴接收;
          否则写作状态下标题、日期与正文工具栏会被这层看不见的盒子挡住点击。
        */}
        <div ref={innerRef} className="pointer-events-none absolute inset-x-0 top-0">
          <header className="lt-app-header pointer-events-auto flex items-start justify-between px-6 pt-6 md:px-10 md:pt-8">
            <div className="flex items-center gap-3">
              <HeaderButton onClick={() => setDrawerOpen(true)} aria-label="打开人生目录" title="人生目录">
                <MenuIcon />
              </HeaderButton>
              <div className="flex flex-col">
                <span className="font-mono text-sm font-medium tracking-[0.3em] text-foreground">
                  LIFE
                </span>
                <span className="text-xs text-muted-foreground/70">My Life</span>
              </div>
              <HeaderActionsToggle
                collapsed={headerActionsCollapsed}
                onToggle={() => setHeaderActionsCollapsed((current) => !current)}
              />
            </div>

            <HeaderActions
              collapsed={headerActionsCollapsed}
              onToggle={(next) => setHeaderActionsCollapsed(next ?? !headerActionsCollapsed)}
            >
              <HeaderButton onClick={() => setGalleryOpen(true)} aria-label="图集" title="图集">
                <GalleryIcon />
              </HeaderButton>
              <HeaderButton onClick={() => setPhoneTransferOpen(true)} aria-label="连接手机" title="连接手机">
                <PhoneComputerIcon />
              </HeaderButton>
              <HeaderButton onClick={() => setSearchOpen(true)} aria-label="搜索" title="搜索">
                <SearchIcon />
              </HeaderButton>
              <ThemeToggle />
              <DiaryActionMenu onSelect={(action) => {
                if (action === 'new') setCreateOpen(true)
                else if (action === 'api') setApiManagerOpen(true)
                else if (action === 'schedule') setScheduleManagerOpen(true)
                else {
                  setDiaryImportReceipt(null)
                  setDiaryTransferMode(action)
                }
              }} />
              <HeaderButton onClick={() => setSettingsOpen(true)} aria-label="时间轴显示设置" title="时间轴显示设置">
                <Settings className="lt-anim-gear size-4" />
              </HeaderButton>
            </HeaderActions>
          </header>

          {/* 人生阶段按钮行 */}
          <div className="pointer-events-auto px-6 pt-5 md:px-10">
            <div ref={stageBoundaryRef} className="relative">
              <LifeStageNav
                stages={stages}
                activeStageId={activeStageId}
                stageCounts={stageCounts}
                managing={managingStages}
                onSelectStage={handleSelectStage}
                onEnterManaging={() => setManagingStages(true)}
                onExitManaging={() => setManagingStages(false)}
                onEditStage={(stage) => setStageDraft(stage)}
                onCreateStage={() => setStageDraft(null)}
              />
              {timelineCollapsed && (
                <TimelineCollapseControl placement="stage" onClick={releaseTimeline} />
              )}
            </div>
            {/*
              当前视口所处阶段的说明。
              高度恒定(不再 h-0 折叠),只用 opacity 淡出 ——
              它让出的空间由下方时间轴组的 translate 收走。
            */}
            <p
              className="mt-3 h-5 max-w-prose truncate text-sm leading-5 text-muted-foreground/70"
              style={{ opacity: 'calc(1 - var(--tl-p, 0) * 2.2)' }}
            >
              {activeStage && (
                <>
                  <span className="font-mono text-xs tracking-wide tabular-nums">
                    {formatStageRange(activeStage)}
                  </span>
                  {activeStage.description && (
                    <span className="font-serif"> · {activeStage.description}</span>
                  )}
                </>
              )}
            </p>
          </div>

          {/* 时间轴组:整体上移(收走说明块与上方留白) */}
          <div
            style={{
              transform: `translate3d(0, calc(${-LIFT} * var(--tl-p, 0) * 1px), 0)`,
              willChange: 'transform',
            }}
          >
            {/*
              时间轴本体。同一个 DOM 实例,从不因状态切换被卸载重建。

              两种收缩手段配合,共同做出"整条人生线向顶部收拢"的空间感:

              · scale —— 等比缩到 82%,是肉眼最明显的那部分。
                origin 取 50% 0(顶部中心):时间轴像是朝页面顶端聚拢,
                而不是某个 DOM 元素在原地缩小。等比缩放不会让圆点变成椭圆。

              · clip-path —— 从底部裁掉阶段区间条与缩放控件行。
                只靠 scale 的话这些辅助层会一路跟到写作状态,顶部不够安静。

              两者都在合成层完成,不触发 reflow,因此不会重新引入抖动。
            */}
            <div
              // clip-path 同时裁剪命中区域:收拢后被裁掉的部分不会再挡住正文
              className="pt-10 pb-4"
              style={{
                transformOrigin: '50% 0',
                transform: `scale(calc(1 - ${1 - SCALE_MIN} * var(--tl-p, 0)))`,
                clipPath: `inset(0 0 calc(${CLIP_BOTTOM} * var(--tl-p, 0) * 1px) 0)`,
                // 折叠后时间轴本体虽仍保留同一个 DOM 以维持横向位置，
                // 但它不能覆盖正文的日期、标题或编辑器；释放按钮在阶段行中单独接收点击。
                pointerEvents: timelineCollapsed ? 'none' : 'auto',
                willChange: 'transform, clip-path',
              }}
            >
              <div
                aria-hidden={timelineCollapsed}
                className="lt-timeline-visual"
                data-timeline-visual-collapsed={timelineCollapsed ? 'true' : 'false'}
                style={{
                  opacity: timelineCollapsed ? 0 : 1,
                  pointerEvents: timelineCollapsed ? 'none' : 'auto',
                  transform: timelineCollapsed ? 'translateY(-14px) scale(0.96)' : 'translateY(0) scale(1)',
                }}
              >
                <LifeTimeline
                  ref={timelineRef}
                  initialCenterYear={restoration.newDay ? dateToDecimalYear(todayKey()) : initialSession?.timelineCenter}
                  events={events}
                  stages={stages}
                  selectedId={selectedId}
                  activeStageId={activeStageId}
                  onSelect={handleSelectNode}
                  onViewportCenterChange={handleViewportCenterChange}
                  onGoToNow={handleGoToNow}
                  collapsed={focusMode}
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/*
        同一页面的下半部分。
        正文一旦存在就不会因为时间轴重新展开而被卸载 ——
        向上滚只是把它推到下面,向下滚又回到它。
      */}
      {writingTarget && writingDocKey ? (
        <EventWritingPane
          // 草稿与真实记录用同一套书写界面：落地那一刻不该有任何视觉跳变。
          // 不设置动态 key，确保 Draft → Daily 时保留编辑器实例、光标与输入法状态。
          event={writingTarget}
          events={events}
          stage={selectedEventStage}
          isDraft={selectedEvent === null}
          autoFocusDraft={draftAutoFocus}
          docKey={writingDocKey}
          editorRef={writingEditorRef}
          topInset={timelineCollapsed ? 0 : H - collapseDistance}
          // 编辑永远写回“屏幕上正在显示的那一篇”:真实记录优先,其次才是草稿
          onChange={selectedEvent
            ? (patch) => store.updateEvent(selectedEvent.id, patch)
            : handleDraftChange}
        />
      ) : (
        <TimelineEmptyState onStartRecording={handleGoToNow} />
      )}

      {/* 左右边缘穿行与底部回顶:fixed 覆盖层,不占据也不影响正文与时间轴的布局。
          任何抽屉 / 搜索 / 大图预览打开时整体暂停 */}
      <EdgeNavigation
        enabled={events.length > 0 && !overlayOpen}
        getTopBoundary={getTopBoundary}
        resolveTargets={resolveAdjacent}
        selectionKey={selectedId ?? (draft ? 'draft' : 'none')}
        onNavigate={handleEdgeNavigate}
      />
      <BackToTop enabled={!overlayOpen} />

      {/* 全局 Drawer / Dialog */}
      {apiManagerOpen && <ApiManagerPage onClose={() => setApiManagerOpen(false)} />}
      {scheduleManagerOpen && <ScheduleManager onClose={() => setScheduleManagerOpen(false)} />}
      {phoneTransferOpen && (
        <PhoneTransferPage
          onClose={() => { setPhoneTransferOpen(false); setPhoneReceivedArchive(null) }}
          onArchiveReceived={(archivePath) => {
            setPhoneTransferOpen(false)
            setPhoneReceivedArchive(archivePath)
            setDiaryImportReceipt(null)
            setDiaryTransferMode('import')
          }}
        />
      )}
      {diaryTransferMode && (
        <DiaryTransferPage
          key={diaryTransferMode}
          mode={diaryTransferMode}
          receipt={diaryImportReceipt}
          initialArchivePath={phoneReceivedArchive}
          onClose={() => { setDiaryTransferMode(null); setDiaryImportReceipt(null); setPhoneReceivedArchive(null) }}
        />
      )}
      <LifeDrawer
        open={drawerOpen}
        events={events}
        stages={stages}
        selectedId={selectedId}
        onClose={() => setDrawerOpen(false)}
        onSelectEvent={handleJumpToEvent}
      />
      <TimelineSettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <SearchDialog
        open={searchOpen}
        events={events}
        onClose={() => setSearchOpen(false)}
        onSelectEvent={handleJumpToEvent}
      />
      <GalleryView
        open={galleryOpen}
        events={events}
        onClose={() => setGalleryOpen(false)}
        onReveal={handleRevealMedia}
      />
      <CreateEventDrawer
        open={createOpen}
        stages={stages}
        presetStage={activeStage}
        onClose={() => setCreateOpen(false)}
        onCreate={handleCreateEvent}
      />
      <StageEditorDrawer
        open={stageDraft !== undefined}
        stage={stageDraft ?? null}
        onClose={() => setStageDraft(undefined)}
        onSubmit={handleSubmitStage}
        onDelete={store.deleteStage}
      />
    </div>
  )
}
