/**
 * 画布视口变换：屏幕↔世界、缩放锚点、钳制、平移、适应视图。
 *
 * 参考 `.infinite-canvas-ref/src/components/canvas/infinite-canvas.tsx`（handleWheel 段）
 * 与 `canvas-zoom-controls.tsx`。
 * 适配改动：缩放上下限沿用 Motif 既有的 0.25–3（上游为 0.05–5，Motif 既有范围是 0.25–3）；
 * 世界坐标换算复用 `geometry.ts` 的 toWorld，不另写一份公式。
 */
import { toWorld, type Rect } from './geometry'

export interface Viewport {
  x: number
  y: number
  k: number
}

/** 缩放上下限：沿用既有 CanvasBoard 的 0.25–3 */
export const MIN_SCALE = 0.25
export const MAX_SCALE = 3
/** 缩放步进：照抄上游 handleWheel 的 1.1 */
export const ZOOM_STEP = 1.1

export function clampScale(k: number): number {
  if (!Number.isFinite(k)) return 1
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, k))
}

/** 源缩放归一：k 非正/非有限时按 1 处理。
 * ⚠️ 必须是全函数：任何公式都不得拿 0/NaN 当分母，否则会产出 NaN 坐标 ——
 * 与 `@motif/core` 的 `viewportOrigin` 同一约定（那边 NaN 落库会撞 NOT NULL 直接抛错）。 */
function baseScale(k: number): number {
  const v = Number.isFinite(k) ? k : 1
  return v > 0 ? v : 1
}

export function screenToWorld(px: number, py: number, v: Viewport): { x: number; y: number } {
  return toWorld(px, py, { x: v.x, y: v.y, scale: baseScale(v.k) })
}

export function worldToScreen(wx: number, wy: number, v: Viewport): { x: number; y: number } {
  return { x: wx * v.k + v.x, y: wy * v.k + v.y }
}

/** 缩放锚点公式：保持锚点（容器内相对坐标）下的世界坐标不动。照抄上游 handleWheel。
 * ⚠️ `real` 的分母必须用**归一后的**源缩放（`from`），不能用原始 `v.k` —— 否则
 * `v.k = 0` 时 `real = Infinity`、`v.k = NaN` 时 `real = NaN`，锚点坐标直接变 NaN。 */
export function zoomAt(v: Viewport, factor: number, anchorX: number, anchorY: number): Viewport {
  const from = baseScale(v.k)
  const k = clampScale(from * factor)
  const real = k / from
  return { k, x: anchorX - (anchorX - v.x) * real, y: anchorY - (anchorY - v.y) * real }
}

export function panBy(v: Viewport, dx: number, dy: number): Viewport {
  return { x: v.x + dx, y: v.y + dy, k: v.k }
}

/** 适应视图：把世界包围盒放进 viewportW×viewportH（留 padding）并居中，k 被钳制 */
export function fitView(bounds: Rect, viewportW: number, viewportH: number, padding = 40): Viewport {
  const availW = Math.max(1, viewportW - padding * 2)
  const availH = Math.max(1, viewportH - padding * 2)
  const bw = Math.max(1, bounds.w)
  const bh = Math.max(1, bounds.h)
  const k = clampScale(Math.min(availW / bw, availH / bh))
  const cx = bounds.x + bw / 2
  const cy = bounds.y + bh / 2
  return { k, x: viewportW / 2 - cx * k, y: viewportH / 2 - cy * k }
}

/** 浮动工具栏的锚点偏移：贴在被选内容包围盒的「上方居中」处，抬高一点避免压住卡片 */
export const TOOLBAR_LIFT = 12

/**
 * 浮动工具栏的定位：被选矩形（世界坐标）包围盒的**顶部居中**，转成容器内屏幕坐标；
 * **贴顶时自动翻到包围盒下方**（首行卡片 `y = 0` 时 `top` 会是 -12，被画布 `overflow-hidden` 裁掉上沿）。
 *
 * ⚠️ 返回的键名必须是 **`left`/`top`** —— 直接返回 `worldToScreen(...)` 的 `{x, y}` 会被
 * React 当成 CSS 属性 `x`/`y`（那是 SVG 语义，对绝对定位元素不生效），
 * 于是工具栏拿不到 left/top，只能落在容器左上角再被 `translateX(-50%)` 推出屏幕。
 * 这正是「框选多张后工具栏跑到别处」的成因，故此处把键名钉死。
 * 也**刻意不加 `placement` 之类的新字段**：既有单测用 `toEqual` 精确匹配键名，加字段会变红，
 * 而 `.canvas-toolbar` 只有 `translateX(-50%)`，锚到下方本身就落在卡片下，不需要样式微调。
 */
export function toolbarAnchor(rects: Rect[], v: Viewport): { left: number; top: number } | null {
  if (rects.length === 0) return null
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
  const cx = (minX + maxX) / 2
  const above = worldToScreen(cx, minY, v)
  const top = above.y - TOOLBAR_LIFT
  // 贴顶（首行卡片 y=0 时 top 会为负）→ 改为锚到包围盒**下方**，否则会被画布 `overflow-hidden` 裁掉上沿。
  // 范围说明：只处理**上沿**越界，下沿不做对称翻转 —— 工具栏锚在卡片上方，卡片贴底时它正好落在
  // 卡片与视口底边之间，本就不会被裁；反过来翻到上方只会盖住卡片内容。
  if (top >= 0) return { left: above.x, top }
  const below = worldToScreen(cx, maxY, v)
  return { left: below.x, top: below.y + TOOLBAR_LIFT }
}
