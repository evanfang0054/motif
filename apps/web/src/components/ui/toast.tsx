'use client'

/**
 * 全站唯一 Toast 出口（heroui-migration GDD L3-2）。
 * P3–P6 一律经此触发，禁止直接使用 @heroui/react 的 toast 底层 API。
 * 文案必须由调用方字面量直传——出口层不得改写/拼接/翻译（契约 D2）。
 */
import { toast } from '@heroui/react'

export function showToast(opts: {
  tone?: 'info' | 'success' | 'warning' | 'danger'
  message: string
  /** 毫秒；缺省用 HeroUI 默认时长（4000ms） */
  timeoutMs?: number
}) {
  const fn =
    opts.tone === 'success' ? toast.success
    : opts.tone === 'warning' ? toast.warning
    : opts.tone === 'danger' ? toast.danger
    : opts.tone === 'info' ? toast.info
    : toast
  fn(opts.message, opts.timeoutMs ? { timeout: opts.timeoutMs } : undefined)
}
