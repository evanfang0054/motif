'use client'

import { useEffect } from 'react'
import {
  DARK_MEDIA_QUERY,
  THEME_STORAGE_KEY,
  isDarkTheme,
  parseThemeMode,
  type ThemeMode,
} from '@/lib/theme'

/**
 * 把三态落到 `<html data-theme>`。
 * 只有 `'dark'` 才写属性、其余一律删除 —— 亮色是「没有属性」的基线态，
 * 写 `data-theme="light"` 会多出一条与 CSS 选择器（`html[data-theme='dark']`）无关的属性。
 */
export function applyThemeMode(mode: ThemeMode) {
  const dark = isDarkTheme(mode, window.matchMedia(DARK_MEDIA_QUERY).matches)
  if (dark) document.documentElement.dataset.theme = 'dark'
  else delete document.documentElement.dataset.theme
}

/**
 * 主题跟随的**常驻层**（#73-1.1）。
 *
 * 为什么必须有它：三态切换控件挂在账号菜单弹层里，点选后弹层关闭即卸载 ——
 * 若 matchMedia 监听挂在弹层内，它随 cleanup 一起消失，运行期再没人听系统明暗变化，
 * 表现为「选跟随系统后切换系统主题不生效，刷新才生效」。
 * 本组件挂在根 layout（覆盖落地页 / 工作台 / 管理后台），**不随任何弹层卸载**。
 *
 * 为什么弹层里不再自己监听：同一件事只留一个执行者。
 * 弹层里的切换只做两件事 —— 写 localStorage + 立即应用一次（点了要当场看到变化）；
 * 之后系统明暗变化由这里处理：每次事件**现读** localStorage 判断当前是不是 system，
 * 因此不需要事件总线，也不需要在两处之间同步状态。
 */
export function ThemeWatcher() {
  useEffect(() => {
    const mq = window.matchMedia(DARK_MEDIA_QUERY)
    const onChange = () => {
      // 现读而不是订阅 state：弹层里的切换不通知任何人，只写 localStorage。
      // 非 system 模式直接忽略 —— 用户明确选过浅色 / 深色时，系统切换不该改页面。
      if (parseThemeMode(localStorage.getItem(THEME_STORAGE_KEY)) !== 'system') return
      applyThemeMode('system')
    }
    mq.addEventListener('change', onChange)
    // 兜底应用一次：内联脚本已先跑过（首帧不闪），这里保证水合后与 localStorage 一致
    applyThemeMode(parseThemeMode(localStorage.getItem(THEME_STORAGE_KEY)))
    return () => mq.removeEventListener('change', onChange)
  }, [])

  // 纯副作用组件：不渲染任何 DOM
  return null
}
