'use client'

/**
 * Toast 队列宿主：Toast.Provider 必须在组件树中渲染一次，
 * 命令式 toast() 才有入列处。layout.tsx 是 server component，
 * 故经由本 client 包装件挂载。
 *
 * placement="top"（2026-09-21 用户裁决）：提示一律**顶部居中**。
 * 默认的 "bottom" 会落在右下角 —— 那里既是画布视图工具栏所在，也是「生成」按钮的下方，
 * 操作后回执出现在视线之外。顶部居中最贴近「刚点完的按钮」的视线落点。
 */
import { Toast } from '@heroui/react'

export function ToastProvider() {
  return <Toast.Provider placement="top" />
}
