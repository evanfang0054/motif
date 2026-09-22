/**
 * 画布小地图：缩略总览 + 视口矩形 + 点击/拖拽跳转。
 *
 * 参考 `.infinite-canvas-ref/src/components/canvas/canvas-mini-map.tsx`（只照抄交互逻辑与公式，JSX 按 Motif 重写）。
 * 与上游的差异（逐条）：
 * 1. 上游节点色按 `node.type` 查 node-registry；Motif 只有图片节点 → 统一取中性令牌 `--muted-strong`。
 * 2. 上游底板用其 canvas-themes 体系；这里沿用画布既有 chrome 的令牌组合
 *    （`--surface-primary` + `--border`，与 `.canvas-pill` / `.canvas-zoombar` 一致），**不新增自研控件类**。
 * 3. 上游「视口缩放/平移只重算视口矩形、不重算包围盒」的分工照抄（见下方两个 useMemo 的依赖）。
 */
'use client'

import { useMemo, useRef } from 'react'
import type { Rect } from '@/lib/canvas/geometry'
import type { Viewport } from '@/lib/canvas/viewport'
import {
  MINIMAP_H,
  MINIMAP_MIN_NODE,
  MINIMAP_W,
  fitMinimap,
  jumpViewport,
  toMinimap,
  toWorld,
  viewportRectIn,
  worldBoundsOf,
} from '@/lib/canvas/minimap'

interface Props {
  /** 画布图片的世界矩形 */
  rects: Rect[]
  viewport: Viewport
  /** 画布容器尺寸（跳转要按容器中心算） */
  size: { w: number; h: number }
  onJump: (v: Viewport) => void
}

function MiniMap({ rects, viewport, size, onJump }: Props) {
  // 包围盒与比例只依赖图片矩形；视口变化不重算它们
  const bounds = useMemo(() => worldBoundsOf(rects), [rects])
  const fit = useMemo(() => fitMinimap(bounds), [bounds])
  const viewRect = useMemo(() => viewportRectIn(viewport, size, bounds, fit), [viewport, size, bounds, fit])
  const squares = useMemo(
    () =>
      rects.map((r) => {
        const p = toMinimap({ x: r.x, y: r.y }, bounds, fit)
        return {
          left: p.x,
          top: p.y,
          width: Math.max(r.w * fit.scale, MINIMAP_MIN_NODE),
          height: Math.max(r.h * fit.scale, MINIMAP_MIN_NODE),
        }
      }),
    [rects, bounds, fit]
  )

  const draggingRef = useRef<number | null>(null)

  const jumpTo = (el: HTMLElement, clientX: number, clientY: number) => {
    const box = el.getBoundingClientRect()
    const world = toWorld({ x: clientX - box.left, y: clientY - box.top }, bounds, fit)
    onJump(jumpViewport(world, viewport, size))
  }

  return (
    <div
      data-testid="canvas-minimap"
      /* role="img"：小地图本质是「画布缩略图」，内部方块对视读器没有独立语义。
         注意它是**指针专用**的（点击/拖拽跳转，无键盘等价物）—— 声明成 img 会隐去这点，
         但也不会比「裸 div 上的 aria-label（被 AT 忽略）」更差。补键盘操作是独立的一件事。 */
      role="img"
      aria-label="小地图"
      /* data-canvas-no-zoom：小地图在画布容器内，不豁免的话滚轮会变成画布缩放 */
      data-canvas-no-zoom
      /* hidden lg:block：窄屏（<1024）不渲染 —— 240px 宽在手机上占掉近半屏。
         与工具栏里那个开关按钮的 `hidden lg:inline-flex` 必须成对，改一处要改两处。
         ⚠️ 位置（2026-09-21 二次调整）：回到**左下角**（`bottom-3 left-3`）。
         上一轮曾因「左下角被左侧浮动面板（left-12 起、z-25）占住，小地图 z-20 会被盖住」
         而挪到画布正中；本轮用户要求回左下角，于是改成**由左侧面板让位** ——
         globals.css 里有一条 `:has()` 规则，小地图在场时把 `.ws-float-left` 的 bottom 抬到 184px
         （12 + 160 + 12），左下角这块就空出来了。左侧于是变成「面板在上、小地图在下」的一条竖列，
         比「小地图盖住面板页脚」或「悬在画布正中挡图」都合理。
         bottom-3 = 12px，与底部工具栏同一条基线（工具栏居中，横向不冲突）。 */
      className="absolute bottom-3 left-3 z-20 hidden touch-none overflow-hidden rounded-lg border shadow-lg lg:block"
      style={{
        width: MINIMAP_W,
        height: MINIMAP_H,
        background: 'var(--surface-primary)',
        borderColor: 'var(--border)',
        cursor: 'pointer',
      }}
      onPointerDown={(e) => {
        e.preventDefault()
        e.stopPropagation() // 不把按下透给画布（否则会同时开始平移/框选）
        draggingRef.current = e.pointerId
        e.currentTarget.setPointerCapture(e.pointerId)
        jumpTo(e.currentTarget, e.clientX, e.clientY)
      }}
      onPointerMove={(e) => {
        if (draggingRef.current !== e.pointerId) return
        jumpTo(e.currentTarget, e.clientX, e.clientY)
      }}
      onPointerUp={(e) => {
        if (draggingRef.current === e.pointerId) draggingRef.current = null
      }}
      onPointerCancel={() => {
        draggingRef.current = null
      }}
    >
      {squares.map((s, i) => (
        <div
          key={i}
          className="absolute rounded-[1px]"
          style={{ left: s.left, top: s.top, width: s.width, height: s.height, background: 'var(--muted-strong)', opacity: 0.8 }}
        />
      ))}
      {/* 视口矩形：只作指示，不吃指针事件 */}
      <div
        data-testid="canvas-minimap-viewport"
        className="pointer-events-none absolute"
        style={{
          left: viewRect.x,
          top: viewRect.y,
          width: viewRect.w,
          height: viewRect.h,
          border: '1px solid var(--accent)',
          background: 'color-mix(in srgb, var(--accent) 12%, transparent)',
        }}
      />
    </div>
  )
}

export { MiniMap }
