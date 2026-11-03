'use client'

// 首页中部空白态:一句轻提示,而不是功能卡片
// 点击任意区域 = 开始记录(打开新建人生节点面板)

interface TimelineEmptyStateProps {
  onStartRecording: () => void
}

export function TimelineEmptyState({ onStartRecording }: TimelineEmptyStateProps) {
  return (
    <button
      type="button"
      onClick={onStartRecording}
      className="group flex w-full cursor-text items-center justify-center px-6 py-20 text-center outline-none"
    >
      <span className="font-serif text-[15px] text-muted-foreground/55 transition-colors duration-300 group-hover:text-muted-foreground group-focus-visible:text-muted-foreground">
        点击任意区域开始记录
      </span>
    </button>
  )
}
