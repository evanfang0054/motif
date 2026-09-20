/**
 * 画布小地图的纯逻辑：世界包围盒 → 缩略图线性变换 → 视口矩形与跳转。
 *
 * 参考 `.infinite-canvas-ref/src/components/canvas/canvas-mini-map.tsx`（只照抄公式，不抄 JSX）。
 * 适配改动：
 * 1. **不复用 `viewport.ts` 的 `fitView`** —— 它内含 `clampScale`（0.25–3），会把小地图的缩略比例钳错；
 *    小地图的 `scale/offset` 是「把世界包围盒塞进 240×160」的另一套数学。
 * 2. 上游按 `node.type` 查 `node-registry` 取节点色；Motif 只有图片节点，取色由组件侧统一给中性令牌。
 * 3. 上游的 240×160 与 ±500 留白是魔法数，这里提成具名常量并注明来源。
 */
import type { Rect } from './geometry'
import type { Viewport } from './viewport'

/** 缩略图尺寸（照抄上游 canvas-mini-map.tsx:12-13） */
export const MINIMAP_W = 240
export const MINIMAP_H = 160
/** 世界单位留白：包围盒四边各外扩（照抄上游 :32-35） */
export const MINIMAP_PAD = 500
/** 视口矩形的最小边长，保证在小地图上始终可点（照抄上游 :81-82） */
export const MINIMAP_MIN_RECT = 4
/** 缩略方块的最小边长（照抄上游 :116-126） */
export const MINIMAP_MIN_NODE = 2
/** 空画布的兜底包围盒（照抄上游 :17 的 1000×1000 居中） */
export const EMPTY_WORLD_BOUNDS: WorldBounds = { x: -500, y: -500, w: 1000, h: 1000 }

export interface WorldBounds {
  x: number
  y: number
  w: number
  h: number
}

export interface MinimapFit {
  scale: number
  offsetX: number
  offsetY: number
}

/** 源缩放归一：非正/非有限按 1（与 viewport.ts 的 baseScale 同一约定，禁止产出 NaN） */
function baseScale(k: number): number {
  const v = Number.isFinite(k) ? k : 1
  return v > 0 ? v : 1
}

/** 图片矩形的世界包围盒，四边各外扩 MINIMAP_PAD；空集合回退 EMPTY_WORLD_BOUNDS */
export function worldBoundsOf(rects: readonly Rect[]): WorldBounds {
  if (rects.length === 0) return { ...EMPTY_WORLD_BOUNDS }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const r of rects) {
    minX = Math.min(minX, r.x)
    minY = Math.min(minY, r.y)
    maxX = Math.max(maxX, r.x + r.w)
    maxY = Math.max(maxY, r.y + r.h)
  }
  minX -= MINIMAP_PAD
  minY -= MINIMAP_PAD
  maxX += MINIMAP_PAD
  maxY += MINIMAP_PAD
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/** contain 适配：等比塞进缩略图并居中（照抄上游 :37-46） */
export function fitMinimap(bounds: WorldBounds): MinimapFit {
  const bw = bounds.w > 0 ? bounds.w : 1
  const bh = bounds.h > 0 ? bounds.h : 1
  const scale = Math.min(MINIMAP_W / bw, MINIMAP_H / bh)
  return {
    scale,
    offsetX: (MINIMAP_W - bw * scale) / 2,
    offsetY: (MINIMAP_H - bh * scale) / 2,
  }
}

export function toMinimap(p: { x: number; y: number }, bounds: WorldBounds, fit: MinimapFit): { x: number; y: number } {
  return { x: (p.x - bounds.x) * fit.scale + fit.offsetX, y: (p.y - bounds.y) * fit.scale + fit.offsetY }
}

/** toMinimap 的逆运算（照抄上游 :63-64） */
export function toWorld(p: { x: number; y: number }, bounds: WorldBounds, fit: MinimapFit): { x: number; y: number } {
  const scale = fit.scale > 0 ? fit.scale : 1
  return { x: (p.x - fit.offsetX) / scale + bounds.x, y: (p.y - fit.offsetY) / scale + bounds.y }
}

/**
 * 视口矩形（缩略图坐标）：先把可见世界范围解出来，再套 toMinimap。
 * 可见世界左上角 = -viewport.x / k，宽高 = 容器尺寸 / k（照抄上游 :71-74）。
 */
export function viewportRectIn(
  viewport: Viewport,
  size: { w: number; h: number },
  bounds: WorldBounds,
  fit: MinimapFit
): Rect {
  const k = baseScale(viewport.k)
  const x0 = -viewport.x / k
  const y0 = -viewport.y / k
  const p1 = toMinimap({ x: x0, y: y0 }, bounds, fit)
  const p2 = toMinimap({ x: x0 + size.w / k, y: y0 + size.h / k }, bounds, fit)
  return {
    x: p1.x,
    y: p1.y,
    w: Math.max(p2.x - p1.x, MINIMAP_MIN_RECT),
    h: Math.max(p2.y - p1.y, MINIMAP_MIN_RECT),
  }
}

/** 点击跳转：把该世界点顶到视口中心，**缩放比例不变**（照抄上游 :87-95） */
export function jumpViewport(
  world: { x: number; y: number },
  viewport: Viewport,
  size: { w: number; h: number }
): Viewport {
  const k = baseScale(viewport.k)
  return { x: size.w / 2 - world.x * k, y: size.h / 2 - world.y * k, k }
}
