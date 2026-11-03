'use client'

// 单个状态按钮:只显示当前主题的图标,点击进入下一个主题
// 亮色 ☀ → 暗色 ☾ → 护眼 ◉ → 亮色
// 悬停动作:太阳光芒转动 / 月亮轻轻摇晃 / 眼睛眨一下;切换时新图标旋入

import { Eye, Moon, Sun } from 'lucide-react'
import { THEME_LABEL, useTheme, type Theme } from '@/lib/theme'
import { HeaderButton } from './header-icons'

const THEME_ICON: Record<Theme, typeof Sun> = {
  light: Sun,
  dark: Moon,
  eyecare: Eye,
}

const THEME_ANIM: Record<Theme, string> = {
  light: 'lt-anim-sun',
  dark: 'lt-anim-moon',
  eyecare: 'lt-anim-eye',
}

export function ThemeToggle() {
  const { theme, cycleTheme } = useTheme()
  const Icon = THEME_ICON[theme]

  return (
    <HeaderButton onClick={cycleTheme} title={THEME_LABEL[theme]} aria-label={`当前${THEME_LABEL[theme]},点击切换`}>
      <span key={theme} className="lt-icon-swap flex">
        <Icon className={`size-4 ${THEME_ANIM[theme]}`} />
      </span>
    </HeaderButton>
  )
}
