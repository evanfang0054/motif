'use client'

import { Button } from '@heroui/react'
import { useCanvasStore } from '@/stores/canvas/useCanvasStore'

/**
 * 缩放百分比读数：**唯一**订阅 `viewport.k` 的地方。
 *
 * 为什么单独成组件：`CanvasStage` 一旦订阅 `k`，**缩放**时整个外层重渲染 ⇒ 重建 20 张卡片的
 * `children` ⇒ 卡片逐帧 reconcile。挪进来后，缩放只让这个小按钮重渲染，外层与卡片子树都不动。
 *
 * ⚠️ 缩小 / 放大两个按钮**不在这里**：它们走稳定的 `zoomAtCenter`（`useCallback(..., [])`，
 *    不读 `k`），搬进来只会多传 props 而没有收益。
 * ⚠️ `aria-label="重置为 100%"` 必须逐字保留 —— e2e 与人工走查都锚它。
 */
export function CanvasZoomReadout() {
  const k = useCanvasStore((s) => s.meta.viewport.k)
  return (
    <Button
      size="sm"
      variant="secondary"
      aria-label="重置为 100%"
      onPress={() => {
        const v = useCanvasStore.getState().meta.viewport
        useCanvasStore.getState().setViewport({ ...v, k: 1 })
      }}
    >
      {Math.round(k * 100)}%
    </Button>
  )
}
