'use client'

import { useEffect, useState } from 'react'
import { ButtonGroup } from '@heroui/react'
import { Display, Moon, Sun } from '@gravity-ui/icons'
import { IconButton } from '@/components/ui/icon-button'

/**
 * 主题三态切换：浅色 / 深色 / 跟随系统（默认浅色）。
 * 持久化在 localStorage('motif-theme')；实际生效由 html[data-theme="dark"] 控制。
 * 首帧防闪烁由 app/layout.tsx 的内联脚本负责，本组件负责交互与 system 模式的实时跟随。
 */
type ThemeMode = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'motif-theme'
const MODE_LABEL: Record<ThemeMode, string> = { light: '浅色', dark: '深色', system: '跟随系统' }
// 图标化（2026-09-21 裁决）：三段文字（浅色/深色/跟随系统）在顶栏最占位，且这三个语义
// 有公认图形（太阳/月亮/显示器）→ 收成图标 + Tooltip。aria-pressed 补上当前选中态，
// 否则图标按钮在视觉上只能靠配色区分，读屏则完全拿不到「当前是哪个模式」。
const MODE_ICON: Record<ThemeMode, React.ReactNode> = {
  light: <Sun />,
  dark: <Moon />,
  system: <Display />,
}
const MODES: ThemeMode[] = ['light', 'dark', 'system']

export function applyThemeMode(mode: ThemeMode) {
  const dark =
    mode === 'dark' ||
    (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  if (dark) document.documentElement.dataset.theme = 'dark'
  else delete document.documentElement.dataset.theme
}

function ThemeToggle() {
  const [mode, setMode] = useState<ThemeMode>('light')
  const [ready, setReady] = useState(false)

  // 挂载时恢复持久化选择（内联脚本已先应用过一次，这里兜底 + 同步按钮态）
  useEffect(() => {
    const saved = (localStorage.getItem(STORAGE_KEY) as ThemeMode | null) ?? 'light'
    setMode(saved)
    applyThemeMode(saved)
    setReady(true)
  }, [])

  // 应用当前模式；system 模式注册 matchMedia 监听，实时跟随系统明暗。
  // 依赖 [mode]：运行中途切到「跟随系统」也要补注册（修复过只挂载时注册一次的 bug）
  useEffect(() => {
    if (!ready) return
    applyThemeMode(mode)
    if (mode !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => applyThemeMode('system')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [ready, mode])

  const select = (next: ThemeMode) => {
    setMode(next)
    localStorage.setItem(STORAGE_KEY, next)
    applyThemeMode(next)
  }

  return (
    <ButtonGroup className="ws-theme-toggle" aria-label="主题外观">
      {MODES.map((m) => (
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
