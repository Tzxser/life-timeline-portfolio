'use client'

// 主人生时间轴:一把可以携带一生的时间尺(§0)
//
// 底层是"时间几何引擎"(lib/timeline-geometry.ts)产出的纯数据:
//   变宽年份分段 / 月·周·日刻度 / 日期桶 / 事件锚点。
//   本组件只渲染,不做几何计算 —— 拖动与纵向滚动永远不触发几何重算(§53)。
//
// 双维缩放(§29-§37):
//   长度(lengthScale) = 横向密度,Ctrl+滚轮 / 控件调节,几何重建
//   宽度(widthScale)  = 纵向气质,设置抽屉调节,只改刻度高度与字号
//   两者都只作用于总览状态;收拢(compact)端点由滚动进度 --tl-p 固定驱动,
//   与用户缩放解耦 —— 无论把时间轴调多大,收起来永远一样安静(§37)。
//
// 布局铁律(继承滚动模型):TRACK_HEIGHT 恒定,任何设置与缩放都不改布局高度。

import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import { cn } from '@/lib/utils'
import { dateToDecimalYear, todayKey, type LifeEvent } from '@/types/life-event'
import { stageRange, type LifeStage } from '@/types/life-stage'
import {
  buildTimelineGeometry,
  parseEventDate,
  yearFraction,
  type DayBucket,
} from '@/lib/timeline-geometry'
import { SETTING_RANGES, useTimelineSettings } from '@/lib/timeline-settings'
import { buildTimelineColorVars } from '@/lib/timeline-colors'
import { useTheme } from '@/lib/theme'
import { TIMELINE_AXIS_Y, TIMELINE_TRACK_HEIGHT } from '@/lib/timeline-ruler-layout'
import { TimelineNode } from './timeline-node'
import { TimelineRuler } from './timeline-ruler'
import { TimelineDayCard } from './timeline-day-card'
import { TimelineControls } from './timeline-controls'
import { TimelineStageBands } from './timeline-stage-bands'
import { TimelineSeasonalLandscape } from './timeline-seasonal-landscape'
import { TimelineNightSky } from './timeline-night-sky'
import { TimelineJourney } from './timeline-journey'
import { seasonalMonths } from '@/lib/seasonal-timeline'

const FIT_PAD = 120 // fit 时左右预留的呼吸空间(px)

/**
 * 时间轴轨道的布局高度(px),恒定不变。
 * 「大时间轴 → 迷你时间轴」完全通过 transform 表达,
 * 因此这个值在任何状态下都不参与动画,页面也就永远不会因它而 reflow。
 * 用户的"宽度"缩放也只在这个固定轨道内改变刻度高度,同样不碰布局。
 */
export const TRACK_HEIGHT = TIMELINE_TRACK_HEIGHT

/**
 * 主轴的纵向位置。
 * 上方 = 具体发生过什么:日刻度 / Today Cursor / 事件刻度与标题(§22)
 * 下方 = 时间本身的结构:周 / 月 / 年 与人生阶段区间(§14)
 */
const AXIS_Y = TIMELINE_AXIS_Y

/** 时间尺分窗渲染的量化步长(px):滚动跨过一格才触发一次刻度重渲染(§55) */
const WINDOW_QUANTUM = 240

// 时间轴两端留白(px)。必须不小于半个视口宽度,否则最早 / 最新的时间点无法被
// 滚动到视口中央。这段留白同时也是"人生线向两端继续延伸"的视觉表达。
function edgePadFor(viewportWidth: number) {
  return Math.max(200, Math.round(viewportWidth / 2) + 80)
}

/** "2026-08-19" → 十进制年份(按真实日历比例,与日刻度坐标完全一致) */
function dateKeyToDecimalYear(dateKey: string): number {
  const { year, month, day } = parseEventDate(dateKey)
  return year + yearFraction(year, month ?? 1, day ?? 1)
}

export interface LifeTimelineHandle {
  /** Exact DOM position, including sub-day movements omitted by stage reports. */
  getViewportCenter: () => number | null
  scrollToYear: (decimalYear: number, smooth?: boolean) => void
  scrollToEvent: (id: string, smooth?: boolean) => void
  /** 把某个具体日期移到视口中央(不改变任何缩放参数,§12) */
  scrollToDate: (dateKey: string, smooth?: boolean) => void
  /** 把一个时间区间平滑地移动到视口中央 */
  scrollToRange: (start: number, end: number, smooth?: boolean) => void
  /** 调整长度缩放,让完整人生跨度尽可能显示在窗口内 */
  fitAll: (smooth?: boolean) => void
}

interface LifeTimelineProps {
  initialCenterYear?: number | null
  events: LifeEvent[]
  stages: LifeStage[]
  selectedId: string | null
  activeStageId: string
  onSelect: (id: string) => void
  onViewportCenterChange?: (decimalYear: number, coversWholeLife: boolean) => void
  /** 点击「现在」:定位今天并直接进入今日记写作(由上层编排,§1) */
  onGoToNow: () => void
  /** 是否已收缩到迷你状态(仅关闭交互热区,视觉由 --tl-p 驱动) */
  collapsed?: boolean
}

// The ruler and its date cards use only event metadata. Body/attachment saves
// must not rebuild geometry or redraw every seasonal tree while someone types.
// Compare callbacks too: a changed handler must never retain a stale closure.
function sameTimelineProps(previous: LifeTimelineProps, next: LifeTimelineProps): boolean {
  if (
    previous.stages !== next.stages || previous.selectedId !== next.selectedId ||
    previous.activeStageId !== next.activeStageId || previous.collapsed !== next.collapsed ||
    previous.initialCenterYear !== next.initialCenterYear || previous.onSelect !== next.onSelect ||
    previous.onViewportCenterChange !== next.onViewportCenterChange || previous.onGoToNow !== next.onGoToNow
  ) return false
  if (previous.events === next.events) return true
  return previous.events.length === next.events.length && previous.events.every((event, index) => {
    const candidate = next.events[index]
    return event === candidate || (
      event.id === candidate.id && event.date === candidate.date &&
      event.datePrecision === candidate.datePrecision && event.title === candidate.title &&
      event.displayDate === candidate.displayDate && event.importance === candidate.importance
    )
  })
}

export const LifeTimeline = memo(forwardRef<LifeTimelineHandle, LifeTimelineProps>(
  function LifeTimeline(
    {
      events,
      stages,
      selectedId,
      activeStageId,
      onSelect,
      onViewportCenterChange,
      onGoToNow,
      collapsed = false,
      initialCenterYear = null,
    },
    ref,
  ) {
    const scrollRef = useRef<HTMLDivElement>(null)
    const didInitRef = useRef(false)
    const { settings, setNumeric, setTimelineStyle } = useTimelineSettings()
    const { theme } = useTheme()
    const lengthScale = settings.lengthScale
    const v = settings.widthScale

    const dragRef = useRef({ dragging: false, moved: false, startX: 0, startScroll: 0 })
    /** 长度缩放后待执行的锚点复位(几何重建后才能换算新坐标) */
    const pendingAnchorRef = useRef<{ year: number; viewportX: number; smooth: boolean } | null>(null)

    const [viewportWidth, setViewportWidth] = useState(0)
    const [scrollLeft, setScrollLeft] = useState(0)
    const seasonal = settings.timelineStyle === 'seasons'
    /** 共享日期卡片:hover 或点击固定,整条时间轴只有这一张(§56) */
    const [dayCard, setDayCard] = useState<{ bucket: DayBucket; pinned: boolean } | null>(null)
    const EDGE_PAD = edgePadFor(viewportWidth)

    useEffect(() => {
      const el = scrollRef.current
      if (!el) return
      setViewportWidth(el.clientWidth)
      const observer = new ResizeObserver(([entry]) => {
        setViewportWidth(entry.contentRect.width)
      })
      observer.observe(el)
      return () => observer.disconnect()
    }, [])

    // 时间跨度覆盖全部事件与全部阶段
    const { startYear, endYear } = useMemo(() => {
      const points: number[] = events.map((e) => dateToDecimalYear(e.date))
      for (const stage of stages) {
        const { start, end } = stageRange(stage)
        points.push(start, end)
      }
      if (points.length === 0) return { startYear: 2007, endYear: 2026 }
      return {
        startYear: Math.floor(Math.min(...points)),
        endYear: Math.ceil(Math.max(...points)),
      }
    }, [events, stages])

    /* ── 几何:只随内容 / 设置 / 长度缩放变化,滚动与 hover 从不触发(§53) */
    const geometry = useMemo(
      () => buildTimelineGeometry(events, startYear, endYear, settings, lengthScale, EDGE_PAD),
      [events, startYear, endYear, settings, lengthScale, EDGE_PAD],
    )
    const { yearToX, xToYear, totalWidth } = geometry
    const months = useMemo(() => seasonalMonths(geometry), [geometry])

    /* ── 事件标题的行分配:按真实估宽做碰撞检测,两行错位,放不下则隐藏(§24)
       标签居中于锚点,因此占用区间是 [x − w/2, x + w/2];
       一行放不下试另一行,都放不下则只留刻度(Hover 仍可见完整信息)。
       选中事件的标题永远显示 —— 它是读者当前的位置感。 */
    const nodeLayouts = useMemo(() => {
      const size = settings.eventLabelSize
      // 标签块 = 标题行 + 日期行,取两者较大宽度。
      // 日期行是 10px mono("2021 年 6 月" ≈ 90px),经常比短标题("高考")更宽 ——
      // 只按标题估宽会让日期行相互叠压。
      const est = (e: LifeEvent) => {
        const title = Math.min(e.title.length, 14) * size * 1.08
        const date = e.displayDate.length * 7.2
        return Math.min(144, Math.max(title, date)) + 16
      }
      /* 年份标签已经移到主轴下方(§16),因此上方这条带整个让给了事件标题 ——
         不再需要为年份让路,可读的标题数量随之提高。 */
      const span = (anchor: (typeof geometry.eventAnchors)[number]) => {
        const w = est(anchor.event)
        return { left: anchor.x - w / 2, right: anchor.x + w / 2 }
      }

      /* 选中事件的标题拥有绝对优先权:它是读者当前所在的位置。
         因此先把它的占位登记下来（固定在行 0），再让其余标题从左到右避开它 ——
         否则"必须显示"的它会与刚好相邻的邻居对撞(刚写完今日记时就会发生)。 */
      const selectedAnchor = selectedId
        ? geometry.eventAnchors.find((a) => a.event.id === selectedId)
        : undefined
      const reserved = selectedAnchor ? span(selectedAnchor) : null

      const rowRight: [number, number] = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY]
      const fits = (row: 0 | 1, left: number, right: number) => {
        if (left < rowRight[row]) return false
        // 行 0 上还要绕开被选中标题预留的区间(它可能位于扫描位置之后)
        if (row === 0 && reserved && right > reserved.left - 14 && left < reserved.right + 14) {
          return false
        }
        return true
      }

      return geometry.eventAnchors.map((anchor) => {
        const { left, right } = span(anchor)
        if (anchor.event.id === selectedId) {
          rowRight[0] = right + 14
          return { ...anchor, row: 0 as const, labelHidden: false }
        }
        let row: 0 | 1 = 0
        let labelHidden = false
        if (fits(0, left, right)) row = 0
        else if (fits(1, left, right)) row = 1
        else labelHidden = true
        if (!labelHidden) rowRight[row] = right + 14
        return { ...anchor, row, labelHidden }
      })
    }, [geometry, settings.eventLabelSize, selectedId])

    /** 把某个时间点移到视口中央(用当前几何) */
    const centerYear = useCallback(
      (decimalYear: number, smooth: boolean) => {
        const el = scrollRef.current
        if (!el) return
        const target = yearToX(decimalYear) - el.clientWidth / 2
        const max = Math.max(0, totalWidth - el.clientWidth)
        el.scrollTo({ left: Math.min(max, Math.max(0, target)), behavior: smooth ? 'smooth' : 'auto' })
      },
      [yearToX, totalWidth],
    )

    const scrollToYear = useCallback(
      (decimalYear: number, smooth = true) => centerYear(decimalYear, smooth),
      [centerYear],
    )

    /* 定位某一天:只改视口位置,绝不触碰 lengthScale / widthScale(§12);
       平滑滚动由浏览器完成,跨越 15 年也不会闪烁重渲染(§13)。 */
    const scrollToDate = useCallback(
      (dateKey: string, smooth = true) => centerYear(dateKeyToDecimalYear(dateKey), smooth),
      [centerYear],
    )

    const scrollToEvent = useCallback(
      (id: string, smooth = true) => {
        const anchor = geometry.eventAnchors.find((a) => a.event.id === id)
        if (!anchor) return
        const el = scrollRef.current
        if (!el) return
        const max = Math.max(0, totalWidth - el.clientWidth)
        el.scrollTo({
          left: Math.min(max, Math.max(0, anchor.x - el.clientWidth / 2)),
          behavior: smooth ? 'smooth' : 'auto',
        })
      },
      [geometry, totalWidth],
    )

    /** 设定新的长度缩放,并保持 anchorYear 停在视口的 viewportX 处 */
    const setLengthKeeping = useCallback(
      (next: number, anchorYear: number, viewportX: number, smooth = false) => {
        const r = SETTING_RANGES.lengthScale
        const clamped = Math.min(r.max, Math.max(r.min, next))
        if (clamped === lengthScale) return
        pendingAnchorRef.current = { year: anchorYear, viewportX, smooth }
        setNumeric('lengthScale', clamped)
      },
      [lengthScale, setNumeric],
    )

    // 长度缩放提交、几何重建后:用新坐标系复位锚点
    useEffect(() => {
      const pending = pendingAnchorRef.current
      if (!pending) return
      pendingAnchorRef.current = null
      const el = scrollRef.current
      if (!el) return
      const max = Math.max(0, totalWidth - el.clientWidth)
      el.scrollTo({
        left: Math.min(max, Math.max(0, yearToX(pending.year) - pending.viewportX)),
        behavior: pending.smooth ? 'smooth' : 'auto',
      })
    }, [yearToX, totalWidth])

    // 阶段定位:调整长度让这段人生占约 70% 视口(几何非线性,但内容宽度与
    // lengthScale 成正比,可直接按比例求解)
    const scrollToRange = useCallback(
      (start: number, end: number, smooth = true) => {
        const el = scrollRef.current
        if (!el) return
        const spanPx = yearToX(end) - yearToX(start)
        const mid = (start + end) / 2
        if (spanPx <= 0) {
          centerYear(mid, smooth)
          return
        }
        const r = SETTING_RANGES.lengthScale
        const ideal = lengthScale * ((el.clientWidth * 0.7) / spanPx)
        const next = Math.min(r.max, Math.max(r.min, Math.min(1.25, ideal)))
        if (Math.abs(next - lengthScale) < 0.01) {
          centerYear(mid, smooth)
          return
        }
        pendingAnchorRef.current = { year: mid, viewportX: el.clientWidth / 2, smooth }
        setNumeric('lengthScale', next)
      },
      [yearToX, lengthScale, centerYear, setNumeric],
    )

    // 「全部」:内容宽度 ∝ lengthScale,按比例缩到刚好装下
    const fitAll = useCallback(
      (smooth = true) => {
        const el = scrollRef.current
        if (!el) return
        const innerWidth = totalWidth - EDGE_PAD * 2
        if (innerWidth <= 0) return
        const r = SETTING_RANGES.lengthScale
        const ideal = lengthScale * ((el.clientWidth - FIT_PAD * 2) / innerWidth)
        const next = Math.min(r.max, Math.max(r.min, ideal))
        pendingAnchorRef.current = {
          year: (startYear + endYear) / 2,
          viewportX: el.clientWidth / 2,
          smooth,
        }
        setNumeric('lengthScale', next)
      },
      [totalWidth, EDGE_PAD, lengthScale, startYear, endYear, setNumeric],
    )

    useImperativeHandle(
      ref,
      () => ({ scrollToYear, scrollToEvent, scrollToDate, scrollToRange, fitAll,
        getViewportCenter: () => {
          const el = scrollRef.current
          return el && didInitRef.current ? xToYear(el.scrollLeft + el.clientWidth / 2) : null
        },
      }),
      [scrollToYear, scrollToEvent, scrollToDate, scrollToRange, fitAll, xToYear],
    )

    /* ── 视口中心上报(供顶部阶段导航高亮) ── */
    const lastReportedRef = useRef<number | null>(null)
    const currentCenterRef = useRef<number | null>(null)
    const lastCoverRef = useRef<boolean | null>(null)
    const reportCenterFrameRef = useRef<number | null>(null)
    const reportCenterNow = useCallback(() => {
      const el = scrollRef.current
      if (!el) return
      // The ruler is windowed in 240px bands. Keep the render state on that
      // same quantum so a horizontal fling does not re-render every node for
      // every fractional scrollLeft change; the exact position remains in the
      // DOM for center reporting and imperative navigation.
      const nextWindow = Math.floor(el.scrollLeft / WINDOW_QUANTUM) * WINDOW_QUANTUM
      setScrollLeft((current) => current === nextWindow ? current : nextWindow)
      if (!onViewportCenterChange) return
      const center = xToYear(el.scrollLeft + el.clientWidth / 2)
      currentCenterRef.current = center
      const coversWholeLife = totalWidth - EDGE_PAD * 2 <= el.clientWidth
      if (
        lastReportedRef.current !== null &&
        Math.abs(center - lastReportedRef.current) < 0.05 &&
        coversWholeLife === lastCoverRef.current
      ) {
        return
      }
      lastReportedRef.current = center
      currentCenterRef.current = center
      lastCoverRef.current = coversWholeLife
      onViewportCenterChange(center, coversWholeLife)
    }, [onViewportCenterChange, xToYear, totalWidth, EDGE_PAD])

    // Horizontal fling events can arrive more often than a frame on Android.
    // Keep the exact scroll position in the DOM, but coalesce the React state
    // and stage-highlight update to one callback per animation frame.
    const reportCenter = useCallback(() => {
      if (reportCenterFrameRef.current !== null) return
      reportCenterFrameRef.current = requestAnimationFrame(() => {
        reportCenterFrameRef.current = null
        reportCenterNow()
      })
    }, [reportCenterNow])

    useEffect(() => () => {
      if (reportCenterFrameRef.current !== null) cancelAnimationFrame(reportCenterFrameRef.current)
      reportCenterFrameRef.current = null
    }, [])

    useEffect(() => {
      lastReportedRef.current = null
      reportCenter()
    }, [reportCenter])

    // 首次进入:居中到"现在"
    useEffect(() => {
      if (didInitRef.current || viewportWidth === 0) return
      didInitRef.current = true
      const now = new Date()
      const nowYear = initialCenterYear ?? dateKeyToDecimalYear(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`)
      currentCenterRef.current = nowYear
      centerYear(nowYear, false)
    }, [viewportWidth, centerYear, initialCenterYear])

    // 窗口尺寸变化后保持当前浏览的时间点不动
    useEffect(() => {
      if (!didInitRef.current || viewportWidth === 0) return
      const center = currentCenterRef.current
      if (center === null) return
      centerYear(center, false)
      // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅在尺寸变化时重新对齐
    }, [viewportWidth])

    /* ── 拖动浏览 ── */
    const onPointerDown = useCallback((e: React.PointerEvent) => {
      const el = scrollRef.current
      if (!el || e.button !== 0) return
      // Let Android's scroll view arbitrate horizontal/vertical gestures and
      // provide inertia. Mouse drag remains the existing desktop interaction.
      if (e.pointerType === 'touch') {
        dragRef.current = { dragging: false, moved: false, startX: e.clientX, startScroll: el.scrollLeft }
        return
      }
      dragRef.current = { dragging: true, moved: false, startX: e.clientX, startScroll: el.scrollLeft }
    }, [])

    const onPointerMove = useCallback((e: React.PointerEvent) => {
      const el = scrollRef.current
      const drag = dragRef.current
      if (e.pointerType === 'touch') {
        if (Math.abs(e.clientX - drag.startX) > 6) drag.moved = true
        return
      }
      if (!el || !drag.dragging) return
      const dx = e.clientX - drag.startX
      if (!drag.moved && Math.abs(dx) > 4) {
        drag.moved = true
        el.setPointerCapture(e.pointerId)
      }
      if (drag.moved) el.scrollLeft = drag.startScroll - dx
    }, [])

    const onPointerUp = useCallback((e: React.PointerEvent) => {
      const el = scrollRef.current
      dragRef.current.dragging = false
      if (el?.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
    }, [])

    const handleSelect = useCallback(
      (id: string) => {
        if (dragRef.current.moved) return
        onSelect(id)
      },
      [onSelect],
    )

    /* ── 日期桶交互:hover 预览 / 点击(单条直达,多条固定卡片选择)(§19-§20)
       离开桶时延迟 250ms 再关卡片：指针从刻度飞向卡片的途中不能把卡片拆掉，
       进入卡片则取消关闭 —— 这是 hover 卡片可以被点击的前提。 */
    const hoverCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
    const cancelCardClose = useCallback(() => {
      if (hoverCloseTimer.current) {
        clearTimeout(hoverCloseTimer.current)
        hoverCloseTimer.current = null
      }
    }, [])
    const handleDayHover = useCallback(
      (bucket: DayBucket | null) => {
        cancelCardClose()
        if (bucket) {
          setDayCard((prev) => (prev?.pinned ? prev : { bucket, pinned: false }))
        } else {
          hoverCloseTimer.current = setTimeout(() => {
            setDayCard((prev) => (prev?.pinned ? prev : null))
          }, 250)
        }
      },
      [cancelCardClose],
    )

    const handleDayClick = useCallback(
      (bucket: DayBucket) => {
        if (dragRef.current.moved) return
        if (bucket.events.length === 1) {
          setDayCard(null)
          onSelect(bucket.events[0].id)
        } else {
          setDayCard({ bucket, pinned: true })
        }
      },
      [onSelect],
    )

    /*
      滚轮分工:
        Ctrl + 滚轮        -> 调整"长度"(横向密度),指针处的时间保持不动(§30)
        横滑 / Shift+滚轮  -> 横向平移(在时间里前后穿行)
        普通竖向滚轮       -> 不拦截,交给页面唯一的纵向滚动容器
    */
    useEffect(() => {
      const el = scrollRef.current
      if (!el) return
      const onWheel = (e: WheelEvent) => {
        if (e.ctrlKey) {
          e.preventDefault()
          const rect = el.getBoundingClientRect()
          const cx = e.clientX - rect.left
          const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12
          setLengthKeeping(lengthScale * factor, xToYear(el.scrollLeft + cx), cx)
        } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
          e.preventDefault()
          el.scrollLeft += e.deltaX || e.deltaY
        }
      }
      el.addEventListener('wheel', onWheel, { passive: false })
      return () => el.removeEventListener('wheel', onWheel)
    }, [lengthScale, setLengthKeeping, xToYear])

    const selectedLayout = nodeLayouts.find(({ event }) => event.id === selectedId)

    /* ── Today Cursor(§6)
       "今天"在挂载后才确定:服务端与客户端的时钟不必一致,首帧不画它就不会有
       hydration 差异。今天一旦有了真实记录(哪怕只是刚写下第一个字),
       日期桶就会出现 —— 此时立刻交还给真实日刻度,两者永不并存。 */
    const [today, setToday] = useState<string | null>(null)
    useEffect(() => {
      setToday(todayKey())
    }, [])
    const todayCursorX =
      today && !geometry.dayBuckets.some((b) => b.key === today)
        ? yearToX(dateKeyToDecimalYear(today))
        : null

    /** 主轴上方紧贴轴线、专属于日刻度桶的浅带高度(与 timeline-node 共用) */
    const dayBandH = settings.dayTickHeight * v + 8

    /* 分窗渲染:滚动位置量化到 240px 步长,跨格才重渲染刻度层(§55) */
    const qStart = Math.floor(scrollLeft / WINDOW_QUANTUM) * WINDOW_QUANTUM - WINDOW_QUANTUM * 2
    const qEnd = qStart + viewportWidth + WINDOW_QUANTUM * 5
    // Use the same overscan as the ruler. Keep the selected node mounted even
    // when it is outside the window; imperative date navigation uses geometry,
    // so older records remain reachable without thousands of off-screen SVGs.
    const visibleNodeLayouts = useMemo(
      () => nodeLayouts.filter((layout) => layout.x >= qStart && layout.x <= qEnd),
      [nodeLayouts, qStart, qEnd],
    )
    // A pinned card follows title/date edits instead of retaining its old
    // bucket object after the geometry has been rebuilt.
    const dayCardBucket = dayCard ? geometry.dayBuckets.find((bucket) => bucket.key === dayCard.bucket.key) : null

    /* 时间轴自身的颜色与深浅,跟随当前主题并保留各层单独覆盖。 */
    const colorVars = buildTimelineColorVars(settings, theme)

    return (
      <section aria-label="人生时间轴" className="lt-seasonal-surface relative" data-timeline-style={seasonal ? 'seasons' : 'plain'} data-timeline-tint={Boolean(settings.timelineTint)} style={{ ...colorVars, '--lt-season-intensity': settings.colorIntensity } as React.CSSProperties}>
        <TimelineNightSky night={theme === 'dark'} />
        <div
          ref={scrollRef}
          onScroll={reportCenter}
          className="lt-timeline-scroll timeline-scroll relative w-full cursor-grab select-none overflow-x-auto overflow-y-hidden active:cursor-grabbing"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          {/* 布局高度恒定:收缩由父级的 transform 完成,这里绝不改 height */}
          <div className="relative" style={{ width: totalWidth, height: TRACK_HEIGHT }}>
            {/* 装饰的预绘范围止于真实轴宽，避免 SVG 溢出反过来扩大 scrollWidth。 */}
            {seasonal && <TimelineSeasonalLandscape
              months={months}
              axisY={AXIS_Y}
              windowStart={Math.max(0, qStart)}
              windowEnd={Math.min(totalWidth, qEnd)}
              lengthScale={lengthScale}
              // Smallest possible tree: importance 1 in spring at this width scale.
              treeHeightLimit={25 * v * .7}
            />}
            {/* 主轴:自定义线宽,两端渐隐表示时间仍在延伸 */}
            <div
              aria-hidden="true"
              className="absolute right-0 left-0"
              style={{
                top: AXIS_Y,
                height: settings.axisStrokeWidth,
                background:
                  'var(--tlc-axis, color-mix(in oklab, var(--color-foreground) 30%, transparent))',
                maskImage:
                  'linear-gradient(to right, transparent 0, #000 320px, #000 calc(100% - 320px), transparent 100%)',
                WebkitMaskImage:
                  'linear-gradient(to right, transparent 0, #000 320px, #000 calc(100% - 320px), transparent 100%)',
                opacity: 'calc(1 - 0.4 * var(--tl-p))',
              }}
            />

            {/* 时间尺:年 / 月 / 周 / 日 四级刻度(分窗渲染) */}
            <TimelineRuler
              geometry={geometry}
              settings={settings}
              v={v}
              axisY={AXIS_Y}
              windowStart={qStart}
              windowEnd={qEnd}
              selectedId={selectedId}
              todayCursorX={todayCursorX}
              onDayHover={handleDayHover}
              onDayClick={handleDayClick}
            />

            {/* 阶段区间条:收拢时先淡出,随后被父级的 clip-path 收走 */}
            {settings.visibility.stageBands && (
              <div style={{ opacity: 'calc(1 - 1.6 * var(--tl-p))' }}>
                <TimelineStageBands
                  stages={stages}
                  activeStageId={activeStageId}
                  yearToX={yearToX}
                  scrollLeft={scrollLeft}
                  viewportWidth={viewportWidth}
                />
              </div>
            )}

            {/*
              事件刻度:其余整体淡入背景,当前选中单独渲染保持完全清晰。
              淡出放在这一个容器上而非逐个标记 —— 每帧开销与事件数量无关。
            */}
            <div style={{ opacity: 'calc(1 - 0.45 * var(--tl-p))' }}>
              {visibleNodeLayouts.map(
                (layout) =>
                  layout.event.id !== selectedId && (
                    <TimelineNode
                      key={layout.event.id}
                      event={layout.event}
                      x={layout.x}
                      selected={false}
                      fuzzy={layout.fuzzy}
                      labelRow={layout.row}
                      labelHidden={layout.labelHidden}
                      axisY={AXIS_Y}
                      v={v}
                      labelSize={settings.eventLabelSize}
                      dayBandH={dayBandH}
                      onSelect={handleSelect}
                      seasonal={seasonal}
                    />
                  ),
              )}
            </div>

            {selectedLayout && (
              <TimelineNode
                key={selectedLayout.event.id}
                event={selectedLayout.event}
                x={selectedLayout.x}
                selected
                fuzzy={selectedLayout.fuzzy}
                labelRow={selectedLayout.row}
                labelHidden={selectedLayout.labelHidden}
                axisY={AXIS_Y}
                v={v}
                labelSize={settings.eventLabelSize}
                dayBandH={dayBandH}
                onSelect={handleSelect}
                seasonal={seasonal}
              />
            )}

            {/* 共享日期卡片:整条时间轴永远只有这一张(§56) */}
            {dayCard && dayCardBucket && (
            <TimelineDayCard
              bucket={dayCardBucket}
              pinned={dayCard.pinned}
              axisY={AXIS_Y}
              onSelectEvent={handleSelect}
              onClose={() => setDayCard(null)}
              onPointerEnterCard={cancelCardClose}
            />
            )}
          </div>
        </div>

        {/* 固定卡片时:点击时间轴外任意处关闭 */}
        {dayCard?.pinned && dayCardBucket && (
          <button
            type="button"
            className="fixed inset-0 z-20 cursor-default"
            aria-label="关闭日期卡片"
            onClick={() => setDayCard(null)}
          />
        )}

        {/* 两侧渐隐 */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-0 left-0 w-16 bg-gradient-to-r from-background to-transparent"
          style={{ height: TRACK_HEIGHT }}
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-0 right-0 w-16 bg-gradient-to-l from-background to-transparent"
          style={{ height: TRACK_HEIGHT }}
        />

        {/* 缩放控制:收拢时淡出但绝不卸载(卸载会改布局高度触发 reflow) */}
        <div
          className={cn('lt-timeline-control-row mt-2', collapsed && 'pointer-events-none')}
          style={{ opacity: 'calc(1 - var(--tl-p))' }}
        >
          <div className="lt-timeline-style" role="group" aria-label="时间轴外观">
            <button type="button" aria-pressed={!seasonal} disabled={collapsed} onClick={() => setTimelineStyle('plain')}>简约</button>
            <button type="button" aria-pressed={seasonal} disabled={collapsed} onClick={() => setTimelineStyle('seasons')}>四季</button>
          </div>
          <TimelineJourney scrollRef={scrollRef} totalWidth={totalWidth} viewportWidth={viewportWidth} months={months} disabled={collapsed} />
          <TimelineControls
            zoom={lengthScale}
            onZoomIn={() => {
              const el = scrollRef.current
              if (!el) return
              const cx = el.clientWidth / 2
              setLengthKeeping(lengthScale * 1.25, xToYear(el.scrollLeft + cx), cx)
            }}
            onZoomOut={() => {
              const el = scrollRef.current
              if (!el) return
              const cx = el.clientWidth / 2
              setLengthKeeping(lengthScale / 1.25, xToYear(el.scrollLeft + cx), cx)
            }}
            onGoToNow={onGoToNow}
          />
        </div>
      </section>
    )
  },
), sameTimelineProps)
