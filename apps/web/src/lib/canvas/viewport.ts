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
 * 与 `@motif/core` 的 `viewportOrigin` 同一约定（那边 NaN 落库会撞 NOT NULL 直接抛错）。
 * 导出给调用方共用（`gridStyle`、`CanvasStage.arrangeAll` 都要这条归一），
 * 内联写 `k > 0 ? k : 1` 会漏掉 Infinity。 */
export function baseScale(k: number): number {
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

/**
 * 浮动工具栏的锚点偏移：贴在被选内容包围盒的「上方居中」处。
 *
 * ⚠️ 值必须 ≥ 工具栏**自身高度**（sm 图标按钮 + 4px 内边距 + 1px 边框 ≈ 42px）——
 * `top` 定的是工具栏的**上边缘**，工具栏从锚点往下长；只抬 12px 时它会压住卡片顶部约 30px
 * （2026-09-21 用户反馈「工具栏挡住图片」的根因）。56 = 42 高度 + 14 间隙。
 */
export const TOOLBAR_LIFT = 56

/** 翻转（贴顶时落到卡片**下方**）的偏移：这里 `top` 是上边缘，只需留一点间隙 */
export const TOOLBAR_DROP = 12

/**
 * 浮动工具栏的定位：被选矩形（世界坐标）包围盒的**顶部居中**，转成容器内屏幕坐标；
 * **贴顶时自动翻到包围盒下方**（首行卡片 `y = 0` 时 `top` 会是负数，被画布 `overflow-hidden` 裁掉上沿）。
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
  return { left: below.x, top: below.y + TOOLBAR_DROP }
}

/** 工具栏左右各留的最小边距（px）：贴到面板/视口边缘时仍看得出是一枚浮动控件 */
export const TOOLBAR_EDGE_GAP = 8

/**
 * 「通栏」判定的边缘容差（px）：窄屏下两侧面板是 `left:12px; right:12px; width:auto` 的底部抽屉，
 * 两侧各留 12 的内边距。取 24（而非 12）只是给「内边距将来调大一点」留余量。
 *
 * ⚠️ 判据刻意**不写成宽度比例**（例如「宽 ≥ 画布 60%」）：那种写法与面板实际宽度隐式耦合，
 * 哪天面板加宽到超过阈值就会**静默反向**（真面板被当成抽屉跳过 → 工具栏直接压在面板上）。
 * 「左右都贴到画布边」才是抽屉的**定义**，与面板多宽无关。
 */
export const DRAWER_EDGE_TOLERANCE = 24

/** 面板的**容器内**矩形。由调用方量好（本模块不碰 DOM，见 `CanvasStage` 里的测量 effect） */
export interface ToolbarPanelRect {
  side: 'left' | 'right'
  left: number
  top: number
  width: number
  height: number
}

/** 通栏（左右都贴着画布边）= 窄屏抽屉。它不是「侧边占位」，见 `DRAWER_EDGE_TOLERANCE` */
function isFullWidthDrawer(p: ToolbarPanelRect, hostWidth: number): boolean {
  if (hostWidth <= 0) return false
  return p.left <= DRAWER_EDGE_TOLERANCE && p.left + p.width >= hostWidth - DRAWER_EDGE_TOLERANCE
}

/**
 * 由各面板的容器内矩形推出工具栏可用的**横向区间**（容器内坐标）。
 *
 * 纯函数：DOM 侧只负责量 rect。这段逻辑有三种情形（单侧开 / 双侧开 / 窄屏抽屉）且最容易写错，
 * 单独可测。
 *
 * 三条规则：
 * ① 收起的面板不在 DOM 里（调用方 `querySelector` 就返回 null），宽高为 0 的跳过只是防御；
 * ② 通栏抽屉整块跳过（见 `isFullWidthDrawer`）；
 * ③ 与工具栏**纵向不重叠**的面板也跳过。宽屏下两侧面板是 `top:12px; bottom:64px` 的整列，
 *    纵向必然重叠、这条不生效；它真正管的是顶部那两条**收起态浮动条**（高 44、只在顶部）——
 *    不判纵向就会拿它去钳画布**底部**的工具栏，白白把工具栏挤到半边去。
 *
 * 已知取舍：画布窄到工具栏比区间还宽时（手机 + 选中首行图片），区间会被两侧收起条挤到比工具栏窄，
 * 退化后必然与收起条部分重叠。此时工具栏 z-index 更高、自己的按钮仍可点，且取消选中即可恢复；
 * 横向钳制无解，故不再为此加纵向分支。
 */
export function toolbarBand(
  hostWidth: number,
  panels: readonly ToolbarPanelRect[],
  toolbar: { top: number; height: number }
): { left: number; right: number } {
  let left = 0
  let right = hostWidth
  for (const p of panels) {
    if (p.width <= 0 || p.height <= 0) continue
    if (isFullWidthDrawer(p, hostWidth)) continue
    if (p.top >= toolbar.top + toolbar.height || p.top + p.height <= toolbar.top) continue
    if (p.side === 'left') left = Math.max(left, p.left + p.width)
    else right = Math.min(right, p.left)
  }
  return { left, right }
}

/**
 * 把工具栏的**中心 x** 钳进可用横向区间，并保证结果落在画布内。
 *
 * 为什么需要：工具栏锚在被选图的顶部居中，图靠画布右缘时它的右半会伸进右侧生成面板的矩形里；
 * 面板 z-index 更高，于是「删除所选图片」被盖住 —— 点下去没有任何反应（#82，实测
 * `elementFromPoint` 命中的是面板里的文本）。抬 z-index 能让它可点，但会变成「工具栏压在面板上」；
 * 所以两条一起做：钳住位置（默认不重叠）＋ 抬高层级（真重叠时也可点）。
 *
 * `band` 是**可用区间**（容器内坐标），已扣掉两侧面板的占位。
 * ⚠️ 区间比工具栏还窄时**不能裸取区间中点**：区间本身可能整条贴在画布边上，中点落在画布外，
 * 工具栏一半被 `overflow:hidden` 裁掉 —— 那就彻底点不到了。退化时改为「区间中点再钳进画布」：
 * 宁可压住面板，也不能推出画布。画布本身比工具栏还窄时只能钉在 half（左右各裁一点，居中）。
 */
export function clampToolbarCenter(
  center: number,
  toolbarWidth: number,
  band: { left: number; right: number },
  hostWidth: number,
  gap = TOOLBAR_EDGE_GAP
): number {
  const half = toolbarWidth / 2 + gap
  const min = band.left + half
  const max = band.right - half
  if (min > max) {
    const mid = (band.left + band.right) / 2
    return Math.min(Math.max(mid, half), Math.max(half, hostWidth - half))
  }
  return Math.min(Math.max(center, min), max)
}
