'use client'

/**
 * Toast 队列宿主：Toast.Provider 必须在组件树中渲染一次，
 * 命令式 toast() 才有入列处。layout.tsx 是 server component，
 * 故经由本 client 包装件挂载。
 */
import { Toast } from '@heroui/react'

export function ToastProvider() {
  return <Toast.Provider />
}
