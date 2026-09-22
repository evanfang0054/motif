'use client'

import { useCallback, useSyncExternalStore } from 'react'

/** 侧栏「常驻浮动」的宽度门槛。⚠️ 必须与 globals.css 里 `.ws-float-panel` 的媒体查询一致 */
export const WIDE_QUERY = '(min-width: 1024px)'

/**
 * 匹配媒体查询。返回 **null = 还不知道**（服务端渲染与 hydration 首帧）。
 *
 * ⚠️ 为什么用 `useSyncExternalStore` 而不是 `useState + useEffect`：
 * 后者要「先渲染一次默认值、effect 里再改」，宽屏上表现为浮动面板**闪一下才出现**。
 * `useSyncExternalStore` 在 hydration 后用 client 快照做同步修正（同一次提交内、paint 之前），
 * 看不到闪；而且它是 React 官方认可的「服务端值 ≠ 客户端值」出口，不会报 hydration mismatch。
 *
 * ⚠️ `getServerSnapshot` 返回 `null` 而不是 `false`：调用方据此区分「确定是窄屏」与「还不知道」，
 * 前者可以保持收起，后者必须**先什么都不渲染** —— 否则窄屏首帧会冒出一个铺满画布的面板。
 */
export function useMediaQuery(query: string): boolean | null {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mq = window.matchMedia(query)
      mq.addEventListener('change', onChange)
      return () => mq.removeEventListener('change', onChange)
    },
    [query]
  )
  const getSnapshot = useCallback(() => window.matchMedia(query).matches, [query])
  // 引用必须稳定：每次返回新函数会让 React 认为快照变了而反复重渲染
  const getServerSnapshot = useCallback((): boolean | null => null, [])
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
