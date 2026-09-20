/**
 * 画布背景图案。
 *
 * 参考 `.infinite-canvas-ref/src/components/canvas/infinite-canvas.tsx:235-256` 的 CanvasGrid。
 * 适配改动（两条，都不照抄）：
 * 1. **底色不抄**：上游用暖底（#f4f2ed / #181715），Motif 的守护线是
 *    「--canvas-background 保持中性」——这是图片工作台，中性底才能准确判断生成图的
 *    颜色与白平衡，暖底会给每张图蒙一层暖色。故本模块**只产出图案**，底色由容器取
 *    `var(--canvas-background)`。
 * 2. **图案色不抄**：上游用 rgba(68,64,60,.28) / rgba(245,245,244,.24)（暖灰）。
 *    这里改为引用两个中性图案色变量（纯黑/纯白 alpha，见 globals.css），
 *    由主题切换驱动，不做 JS 判主题 —— 避免浅深主题不一致。
 */
import type { CanvasBackgroundMode } from '@motif/core'
import type { Viewport } from './viewport'

/** 基准网格边长：照抄上游的 48 */
export const GRID_BASE = 48

export interface GridStyle {
  backgroundImage: string
  backgroundSize: string
  backgroundPosition: string
}

/** 图案样式；'blank' 返回 null（不渲染图案层） */
export function gridStyle(mode: CanvasBackgroundMode, viewport: Viewport): GridStyle | null {
  if (mode === 'blank') return null
  // k 归一：非正/非有限按 1 —— 否则 gridSize 为 0 或 NaN，backgroundPosition 会算出
  // "NaNpx"，浏览器丢弃非法声明，图案直接变空白（与 viewportOrigin 同一约定）
  const k = Number.isFinite(viewport.k) && viewport.k > 0 ? viewport.k : 1
  const gridSize = GRID_BASE * k
  const x = viewport.x % gridSize
  const y = viewport.y % gridSize
  // 缩到很小时点变小，避免糊成一片（照抄上游的 0.12 阈值）。
  // ⚠️ 经 clampScale 的正规路径下 k ≥ MIN_SCALE(0.25)，此分支不可达；它是为
  // 「canvas_meta 被手工改脏成 k=0.05」留的防御（normalizeCanvasMeta 只保证 k>0）。
  const dotSize = k < 0.12 ? 0.8 : 1.15
  const backgroundImage =
    mode === 'dots'
      ? `radial-gradient(circle, var(--canvas-grid-dot) ${dotSize}px, transparent ${dotSize + 0.2}px)`
      : `linear-gradient(var(--canvas-grid-line) 1px, transparent 1px), linear-gradient(90deg, var(--canvas-grid-line) 1px, transparent 1px)`
  return {
    backgroundImage,
    backgroundSize: `${gridSize}px ${gridSize}px`,
    backgroundPosition: `${x}px ${y}px`,
  }
}
