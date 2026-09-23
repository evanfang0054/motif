'use client'

import { useEffect, useState } from 'react'
import { ButtonGroup } from '@heroui/react'
import { Display, Moon, Sun } from '@gravity-ui/icons'
import { IconButton } from '@/components/ui/icon-button'
import { applyThemeMode } from '@/components/ThemeWatcher'
import {
  DEFAULT_THEME_MODE,
  THEME_MODES,
  THEME_STORAGE_KEY,
  parseThemeMode,
  type ThemeMode,
} from '@/lib/theme'

/**
 * 主题三态切换：浅色 / 深色 / 跟随系统（默认浅色）。
 * 持久化在 localStorage('motif-theme')；实际生效由 html[data-theme="dark"] 控制。
 *
 * 职责边界（#73-1.1）：
 * - 首帧防闪烁：`app/layout.tsx` 的内联脚本（水合前跑）。
 * - 运行期跟随系统：`components/ThemeWatcher.tsx`（根 layout 的常驻监听）。
 * - 本组件：只负责「用户点了哪一档」—— 写 localStorage + 立即应用一次（点击要当场见效），
 *   **不再自己挂 matchMedia 监听**：它挂在账号菜单弹层里，弹层一关就卸载，
 *   监听会随 cleanup 一起消失（那正是「跟随系统失效」的根因）。
 */
const MODE_LABEL: Record<ThemeMode, string> = { light: '浅色', dark: '深色', system: '跟随系统' }
// 图标化（2026-09-21 裁决）：三段文字（浅色/深色/跟随系统）在顶栏最占位，且这三个语义
// 有公认图形（太阳/月亮/显示器）→ 收成图标 + Tooltip。aria-pressed 补上当前选中态，
// 否则图标按钮在视觉上只能靠配色区分，读屏则完全拿不到「当前是哪个模式」。
const MODE_ICON: Record<ThemeMode, React.ReactNode> = {
  light: <Sun />,
  dark: <Moon />,
  system: <Display />,
}

function ThemeToggle() {
  const [mode, setMode] = useState<ThemeMode>(DEFAULT_THEME_MODE)

  // 挂载时同步按钮态（主题本身已由内联脚本 / 常驻监听应用过，这里只把选中态读回来）。
  // 弹层每次打开都重新挂载 ⇒ 每次都读到最新的 localStorage，不需要跨组件同步。
  useEffect(() => {
    setMode(parseThemeMode(localStorage.getItem(THEME_STORAGE_KEY)))
  }, [])

  const select = (next: ThemeMode) => {
    setMode(next)
    localStorage.setItem(THEME_STORAGE_KEY, next)
    // 立即应用一次：常驻监听只在**系统明暗变化**时被唤醒，不会因为一次 localStorage 写入而触发，
    // 少了这一句点选要等下一次系统变化才见效。
    applyThemeMode(next)
  }

  return (
    <ButtonGroup className="ws-theme-toggle" aria-label="主题外观">
      {THEME_MODES.map((m) => (
        <IconButton
          key={m}
          size="sm"
          label={MODE_LABEL[m]}
          aria-pressed={mode === m}
          variant={mode === m ? 'primary' : 'secondary'}
          onPress={() => select(m)}
        >
          {MODE_ICON[m]}
        </IconButton>
      ))}
    </ButtonGroup>
  )
}

export { ThemeToggle }
