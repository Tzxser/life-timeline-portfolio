// 顶栏的自绘图标。每个图标都有一段只在悬停 / 键盘聚焦时播放一次的小动作,
// 动作本身写在 globals.css 的 .lt-hbtn 规则里(并尊重“减少动态效果”设置)。

import type { ComponentPropsWithRef } from 'react'
import { cn } from '@/lib/utils'

export function HeaderButton({ className, ...props }: ComponentPropsWithRef<'button'>) {
  return (
    <button
      type="button"
      className={cn(
        'lt-hbtn flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
        className,
      )}
      {...props}
    />
  )
}

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

/** 翻开的书:悬停时右页的两张书页先后翻到左边 */
export function GalleryIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn('size-[18px] overflow-visible', className)} aria-hidden="true" {...stroke}>
      <path d="M12 7c-1.8-1.3-4.6-2-8-2v12.5c3.4 0 6.2.7 8 2" />
      <path d="M12 7c1.8-1.3 4.6-2 8-2v12.5c-3.4 0-6.2.7-8 2" />
      <path d="M12 7v12.5" />
      <path className="lt-leaf" d="M12 7c1.8-1.3 4.6-2 8-2v12.5c-3.4 0-6.2.7-8 2" />
      <path className="lt-leaf lt-leaf-2" d="M12 7c1.8-1.3 4.6-2 8-2v12.5c-3.4 0-6.2.7-8 2" />
    </svg>
  )
}

/** 电脑与手机相连：两端靠近时，中间的无线连线轻轻亮起。 */
export function PhoneComputerIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" data-transfer-icon="phone" className={cn('size-[18px] overflow-visible', className)} aria-hidden="true" {...stroke}>
      <g className="lt-phone-computer">
        <rect x="2.5" y="5" width="11.5" height="8" rx="1.2" />
        <path d="M5.5 16h5.5M8.25 13v3" />
      </g>
      <g className="lt-phone-device">
        <rect x="15.5" y="3" width="6" height="13" rx="1.5" />
        <path d="M17.8 13.5h1.4" />
      </g>
      <path className="lt-phone-link" d="M13.8 8.5c.8-.7 1.5-.7 2.3 0M13.8 11.4c.8.7 1.5.7 2.3 0" />
    </svg>
  )
}

/** 放大镜:悬停时轻轻巡视一圈,镜片上的高光闪两下 */
export function SearchIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn('lt-anim-search size-4 overflow-visible', className)} aria-hidden="true" {...stroke}>
      <circle cx="10.5" cy="10.5" r="6.5" strokeWidth={1.8} />
      <path d="M20 20l-4.8-4.8" strokeWidth={1.8} />
      <path className="lt-glint" d="M7.4 9.4a3.4 3.4 0 0 1 2.3-2.3" strokeWidth={1.6} />
    </svg>
  )
}

/** 顶部功能收纳：两条竖线向内合拢，展开时再轻轻分开。 */
export function HeaderCollapseIcon({ collapsed, className }: { collapsed: boolean; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      data-header-collapse-icon=""
      data-collapsed={collapsed ? 'true' : 'false'}
      className={cn('size-[17px] overflow-visible', className)}
      aria-hidden="true"
      {...stroke}
    >
      <rect className="lt-collapse-frame" x="3.5" y="4" width="17" height="16" rx="2" />
      <path className="lt-collapse-divider" d="M12 4v16" />
      <path className="lt-collapse-chevron" d="m9.5 9-3 3 3 3M14.5 9l3 3-3 3" />
    </svg>
  )
}

/** 目录:三条线依次收拢再展开,像翻动目录页 */
export function MenuIcon({ className }: { className?: string }) {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" className={cn('overflow-visible', className)} aria-hidden="true">
      <path className="lt-line" d="M1.5 3h12" stroke="currentColor" strokeLinecap="round" />
      <path className="lt-line lt-line-2" d="M1.5 7.5h12" stroke="currentColor" strokeLinecap="round" />
      <path className="lt-line lt-line-3" d="M1.5 12h12" stroke="currentColor" strokeLinecap="round" />
    </svg>
  )
}

/** 线上新添的一刻：时间轴与一枚轻轻亮起的新节点。 */
export function NewLifeNodeIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" data-transfer-icon="new" className={cn('size-5 overflow-visible', className)} aria-hidden="true" {...stroke}>
      <path d="M3 17h18M6 17v-3M18 17v-3" />
      <path d="M12 17v-5" />
      <g className="lt-node-spark">
        <circle cx="12" cy="8" r="3" />
        <path d="M12 2v1M5.8 5.5l.9.5M18.2 5.5l-.9.5" />
      </g>
    </svg>
  )
}

/** 收进纸页：箭头落入翻开的日记本。 */
export function DiaryImportIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" data-transfer-icon="import" className={cn('size-5 overflow-visible', className)} aria-hidden="true" {...stroke}>
      <path d="M4 10v9c3.2-.2 5.7.5 8 2 2.3-1.5 4.8-2.2 8-2v-9M12 15v6" />
      <path d="M4 10c1.5-.1 2.8.1 4 .4M20 10c-1.5-.1-2.8.1-4 .4" />
      <g className="lt-diary-in-arrow"><path d="M12 2v10M8.8 8.8 12 12l3.2-3.2" /></g>
    </svg>
  )
}

/** 带走纸页：箭头从折角封套中轻轻升起。 */
export function DiaryExportIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" data-transfer-icon="export" className={cn('size-5 overflow-visible', className)} aria-hidden="true" {...stroke}>
      <path d="M5 9H3v12h18V9h-2M3 15h5l1.5 2h5l1.5-2h5" />
      <g className="lt-diary-out-arrow"><path d="M12 13V3M8.8 6.2 12 3l3.2 3.2" /></g>
    </svg>
  )
}

/** 接口连接：两枚插头靠近，连起中间的短线。 */
export function ApiManagerIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" data-transfer-icon="api" className={cn('size-5 overflow-visible', className)} aria-hidden="true" {...stroke}>
      <g className="lt-api-left"><path d="M2 8h3v8H2M5 10h4M5 14h4" /></g>
      <path className="lt-api-link" d="M10 12h4" />
      <g className="lt-api-right"><path d="M22 8h-3v8h3M19 10h-4M19 14h-4" /></g>
      <path d="M12 3v2M12 19v2" />
    </svg>
  )
}

/** 纸页与一颗星：辅助整理，原文仍留在纸上。 */
export function AiDiaryIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn('size-5 overflow-visible', className)} aria-hidden="true" {...stroke}>
      <path d="M11 3H4v18h15v-9M7 9h4M7 13h7M7 17h8" />
      <path className="lt-node-spark" d="m17 2 1.5 3.5L22 7l-3.5 1.5L17 12l-1.5-3.5L12 7l3.5-1.5Z" />
    </svg>
  )
}
