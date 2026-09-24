/**
 * 画布内核类型：服务端与客户端共享。
 *
 * 画布 = 升级后的 topic，零新表：图片的摆放写回 `canvas_images` 的 5 个新列，
 * 视口/背景写回 `topics.canvas_meta`（JSON）。血缘/版本链/批量聚簇不落表，由
 * `lib/canvas/lineage.ts` 从既有 message_id 与 reference_ids 推导。
 *
 * 参考 `.infinite-canvas-ref/src/types/canvas.ts`（Position/ViewportTransform/SelectionBox
 * 的类型组织方式），以及 `.infinite-canvas-ref/src/lib/canvas/canvas-node-size.ts`
 * 的 `fitNodeSize`（本文件 `displaySize` 的来源）与
 * `.infinite-canvas-ref/src/lib/canvas/canvas-node-factory.ts`（空位槽落位思路）。
 * 适配改动：上游的节点类型（text/config/video/audio/group）全部不要 —— Motif 只有图片节点；
 * 上游按「节点中心点」定位，这里按「视口左上角起 4 列网格找空位」定位。
 */

import { resolveSize } from './validation'

/** 画布上图片的摆放。⚠️ canvasWidth/canvasHeight 是**画布上的显示尺寸**，
 * 与 CanvasImage.width/height（**原图像素尺寸**）是两回事，命名刻意区分。 */
export interface CanvasImagePlacement {
  id: string
  canvasX: number
  canvasY: number
  canvasWidth: number
  canvasHeight: number
  /** 图片级 LWW 的版本依据（ISO 时间）；空串 = 升级库的老行，待补位 */
  updatedAt: string
}

/** 背景图案三态。与上游 infinite-canvas 的 CanvasBackgroundMode 一致，默认 lines。 */
export type CanvasBackgroundMode = 'dots' | 'lines' | 'blank'

export interface CanvasViewport {
  x: number
  y: number
  k: number
}

export interface CanvasMeta {
  viewport: CanvasViewport
  background: CanvasBackgroundMode
  version: 1
}

/**
 * 允许「只给部分字段」的元信息（含只给部分视口字段）。
 * 归一函数本就逐字段容错，故类型也如实放宽 —— 这样「只改背景」「只改缩放」都能直接表达。
 */
export interface CanvasMetaInput {
  viewport?: Partial<CanvasViewport>
  background?: CanvasBackgroundMode
  version?: 1
}

/** PATCH 增量补丁：贴合「防抖批量提交」的形态，天然避免整画布覆盖 */
export interface CanvasPatch {
  images?: { upsert?: CanvasImagePlacement[]; delete?: string[] }
  meta?: CanvasMetaInput
}

export interface CanvasSnapshot {
  images: CanvasImagePlacement[]
  meta: CanvasMeta
}

/**
 * 结构校验：一条摆放是否形状合法 —— id 非空、位置/尺寸是有限数字、尺寸为正、
 * 版本为非空字符串（空串是「升级库老行待补位」的哨兵，客户端不得用它落位）。
 *
 * ⚠️ 服务端写入（`/api/topics/[id]/canvas` 的 PATCH）与画布文件导入
 * （`lib/canvas/serialization.ts`）**共用这一条判据** —— 两处各写一份必然漂移
 * （曾经就是路由严、导入松：导入能塞进 `canvasX: "abc"` 这种值）。
 */
export function isCanvasImagePlacement(v: unknown): v is CanvasImagePlacement {
  if (!v || typeof v !== 'object') return false
  const p = v as Partial<CanvasImagePlacement>
  if (typeof p.id !== 'string' || !p.id) return false
  const nums = [p.canvasX, p.canvasY, p.canvasWidth, p.canvasHeight]
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return false
  if (!(p.canvasWidth! > 0) || !(p.canvasHeight! > 0)) return false
  return typeof p.updatedAt === 'string' && p.updatedAt.trim() !== ''
}

export const DEFAULT_CANVAS_META: CanvasMeta = {
  viewport: { x: 0, y: 0, k: 1 },
  background: 'lines',
  version: 1,
}

const BACKGROUND_MODES: CanvasBackgroundMode[] = ['dots', 'lines', 'blank']

/**
 * 数值兜底：非 number 或非有限值一律回退默认。
 *
 * 导出给调用方共用 —— HeroUI / RAC 的 `NumberField` 在输入框被清空并失焦时给的是 `NaN`
 * （不是 `null`），`v ?? 默认值` 接不住，各处都要用这个判据；各写一份必然改一处漏一处。
 */
export function finiteNumber(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/** 归一：任何缺字段/坏值都回退默认，绝不抛错（脏 JSON 不能把画布打不开） */
export function normalizeCanvasMeta(input: CanvasMetaInput | null | undefined): CanvasMeta {
  const vp = input?.viewport
  const background = BACKGROUND_MODES.includes(input?.background as CanvasBackgroundMode)
    ? (input!.background as CanvasBackgroundMode)
    : DEFAULT_CANVAS_META.background
  // k 必须为正：k<=0 会让 viewportOrigin 除零 → NaN 位置 → 写进 NOT NULL 列直接抛错，
  // 之后每次 GET 都 500（画布再也打不开）。故非正值一律回退默认缩放。
  const k = finiteNumber(vp?.k, DEFAULT_CANVAS_META.viewport.k)
  return {
    viewport: {
      x: finiteNumber(vp?.x, DEFAULT_CANVAS_META.viewport.x),
      y: finiteNumber(vp?.y, DEFAULT_CANVAS_META.viewport.y),
      k: k > 0 ? k : DEFAULT_CANVAS_META.viewport.k,
    },
    background,
    version: 1,
  }
}

/** 容错解析 topics.canvas_meta 列（升级库默认 '{}'，脏数据回退默认值） */
export function parseCanvasMeta(raw: string | null | undefined): CanvasMeta {
  try {
    const v = JSON.parse(raw || '{}')
    return normalizeCanvasMeta(v && typeof v === 'object' ? (v as CanvasMetaInput) : null)
  } catch {
    return { ...DEFAULT_CANVAS_META }
  }
}

// ---------- 空位槽与显示尺寸（服务端补位与客户端落位共用，故实现在 core） ----------

/** 空位槽几何：槽宽 240，槽间距 40，步长 280；显示尺寸钳制在 240×240 内，
 * 因此任意两个不同槽位永不重叠（240 < 280）。 */
export const SLOT_W = 240
export const SLOT_GAP = 40
export const SLOT_STEP = SLOT_W + SLOT_GAP
export const SLOT_COLS = 4

/**
 * 血缘落位的**列间距**（锚点右缘 → 新列左缘）。
 *
 * 与「按血缘整理」（`apps/web/src/lib/canvas/lineage.ts` 的树形布局）同源：两处各写一份
 * 必然漂移，而「生成后的样子 ≈ 点一次整理」正是这次改动的验收口径 —— 值对不上就白改了。
 */
export const LINEAGE_COL_GAP = 120

export interface CanvasRect { x: number; y: number; w: number; h: number }

/**
 * `CanvasRect` 的**运行时形状判据**（类型守卫）。
 *
 * 为什么单独抽到 core：这个形状有两处「必须不信输入」的消费者 ——
 * ① 服务端读库（`@motif/db` 的 `safeParseSlotPlan` 解析 `slot_plan` 列）；
 * ② 客户端读 API（`apps/web` 的 `pendingSkeletonSlots` 取 `slotPlan`）。
 * 两处口径必须一致：槽位坐标会直接喂给 `left/top/width/height`，坏值（NaN / 负尺寸 / 非数字）
 * 会渲染出诡异的占位块，比「没有骨架」更糟。各写一份必然漂移，故下沉到这里共用。
 *
 * 判据：`x/y/w/h` 都是**有限数**且 `w/h > 0`（尺寸为 0 或负数不是合法矩形）。
 */
export function isCanvasRect(v: unknown): v is CanvasRect {
  if (!v || typeof v !== 'object') return false
  const r = v as Partial<CanvasRect>
  if (![r.x, r.y, r.w, r.h].every((n) => typeof n === 'number' && Number.isFinite(n))) return false
  return (r.w as number) > 0 && (r.h as number) > 0
}

export function placementRect(p: CanvasImagePlacement): CanvasRect {
  return { x: p.canvasX, y: p.canvasY, w: p.canvasWidth, h: p.canvasHeight }
}

export function rectToPlacement(id: string, r: CanvasRect, updatedAt: string): CanvasImagePlacement {
  return { id, canvasX: r.x, canvasY: r.y, canvasWidth: r.w, canvasHeight: r.h, updatedAt }
}

/** 视口可见区域的左上角（世界坐标）——新图片落位到用户当前看到的地方。
 * ⚠️ 必须是**全函数**：k 非正/非有限时按 1 处理，绝不产出 NaN/Infinity ——
 * NaN 写进 canvas_x 这类 NOT NULL 列会被 SQLite 当成 NULL 而直接抛错，
 * 让「旧库补位」在 GET 里炸掉，画布从此打不开。-0 也归一成 0，避免负零漏进库与 JSON。 */
export function viewportOrigin(v: CanvasViewport): { x: number; y: number } {
  const raw = finiteNumber(v.k, 1)
  const k = raw > 0 ? raw : 1
  const x = -finiteNumber(v.x, 0) / k
  const y = -finiteNumber(v.y, 0) / k
  return { x: x === 0 ? 0 : x, y: y === 0 ? 0 : y }
}

/**
 * 显示尺寸：按原图比例缩放到 max 内，**不放大、不拉伸**。
 * 原图尺寸未知（上传参考图 width/height 为 0）时回退正方形槽位。
 * 照抄 `.infinite-canvas-ref/src/lib/canvas/canvas-node-size.ts` 的 fitNodeSize。
 */
export function displaySize(naturalWidth: number, naturalHeight: number, maxW = SLOT_W, maxH = SLOT_W): { width: number; height: number } {
  if (!(naturalWidth > 0) || !(naturalHeight > 0)) return { width: maxW, height: maxH }
  const scale = Math.min(1, maxW / naturalWidth, maxH / naturalHeight)
  return { width: naturalWidth * scale, height: naturalHeight * scale }
}

/**
 * 把一组矩形整体平移，让**包围盒居中于视口可见区域**。
 *
 * 2026-09-21 用户裁决：「整理布局」原先从 `origin`（视口左上角的世界坐标）起铺 4 列网格，
 * 结果整块贴在画布左上角；用户要的是「规整到中间的区域」。
 *
 * ⚠️ 块比可见区大时**不做居中**，退回「左上角对齐 origin」：
 * 居中的话左半/上半会被推到屏幕外（比原来更糟），而对齐原点至少能看见开头几行。
 * 空数组直接返回，不做 `Math.min()`（会得到 Infinity）。
 */
export function centerRectsInViewport(
  rects: CanvasRect[],
  origin: { x: number; y: number },
  viewW: number,
  viewH: number
): CanvasRect[] {
  if (rects.length === 0) return rects
  const minX = Math.min(...rects.map((r) => r.x))
  const minY = Math.min(...rects.map((r) => r.y))
  const maxX = Math.max(...rects.map((r) => r.x + r.w))
  const maxY = Math.max(...rects.map((r) => r.y + r.h))
  const blockW = maxX - minX
  const blockH = maxY - minY
  const dx = blockW <= viewW ? origin.x + (viewW - blockW) / 2 - minX : origin.x - minX
  const dy = blockH <= viewH ? origin.y + (viewH - blockH) / 2 - minY : origin.y - minY
  if (dx === 0 && dy === 0) return rects
  return rects.map((r) => ({ ...r, x: r.x + dx, y: r.y + dy }))
}

/**
 * 矩形相交（贴边不算）：a 与 b 有正面积重叠。
 * 与 `apps/web/src/lib/canvas/geometry.ts` 的 `rectsIntersect` 同语义 —— 导出它是因为
 * worker 落位前要拿它做「计划槽是否已被占用」的校验（服务端只依赖 core，不引客户端几何库）。
 */
export function rectsIntersect(a: CanvasRect, b: CanvasRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/**
 * 空位槽分配：从 origin 起按 4 列网格找与 occupied/已分配矩形都不相交的槽。
 * 上限 10000 次尝试；耗尽则退化为「在所有矩形下方另起一行」，保证确定性且不重叠。
 */
export function allocateSlots(
  occupied: CanvasRect[],
  sizes: Array<{ width: number; height: number }>,
  origin: { x: number; y: number }
): CanvasRect[] {
  const taken = [...occupied]
  const out: CanvasRect[] = []
  let i = 0
  let tries = 0
  while (out.length < sizes.length && tries < 10000) {
    tries += 1
    const size = sizes[out.length]
    const cand: CanvasRect = {
      x: origin.x + (i % SLOT_COLS) * SLOT_STEP,
      y: origin.y + Math.floor(i / SLOT_COLS) * SLOT_STEP,
      w: size.width,
      h: size.height,
    }
    i += 1
    if (taken.some((r) => rectsIntersect(r, cand))) continue
    taken.push(cand)
    out.push(cand)
  }
  if (out.length < sizes.length) {
    let y = taken.reduce((m, r) => Math.max(m, r.y + r.h), origin.y) + SLOT_GAP
    for (let k = out.length; k < sizes.length; k += 1) {
      const size = sizes[k]
      out.push({ x: origin.x, y, w: size.width, h: size.height })
      y += size.height + SLOT_GAP
    }
  }
  return out
}

// ---------- 生成槽位计划（#88：提交即预占骨架、出图就地填入） ----------

/**
 * 入队时一次性算好 N 个「待生成槽位」。
 *
 * 这是「骨架落位」与「出图落位」**共用同一个 `allocateSlots`** 的唯一入口 ——
 * 两边各算一份必然漂移，出图瞬间就会「跳一下」。故计划在服务端算一次、随消息下发，
 * worker 出图时直接落回 `plan[i]`，前端骨架也渲染在同一坐标上。
 *
 * 落位原点：给了 `anchor`（本轮有参考图）就按血缘落在锚点右侧一列（见 `planLineageColumn`），
 * 否则维持「视野左上角起 4 列网格找空位」——**骨架与出图走的是同一条分支**，不会各落一处。
 *
 * 尺寸口径（D13）：请求尺寸 = `auto` 时 `resolveSize` 兜底成 1024×1024（即 1:1），
 * 再经 `displaySize` 钳进 240×240 —— 于是 **auto 一律按 1:1 占位**；已知比例
 * （方图 / 竖图 / 横图 / 自定义）按各自比例占位。出图比例与占位不同时由前端做平滑过渡
 * （见 CanvasStage 的骨架渲染：只变尺寸、不动左上角，故不会压到相邻图）。
 */
export function planSlotRects(
  occupied: CanvasRect[],
  requestedSize: string,
  count: number,
  origin: { x: number; y: number },
  /**
   * 血缘锚点：本轮第一张参考图的摆放（见 `services.ts` 的 `anchorRectOf`）。
   * 给了就落在它**右侧一列**；没给（纯文生图 / 参考图都不在画布上）走原来的空位槽网格。
   */
  anchor?: CanvasRect | null
): CanvasRect[] {
  const px = resolveSize(requestedSize)
  const size = displaySize(px.width, px.height)
  const sizes = Array.from({ length: count }, () => size)
  if (anchor) {
    const column = planLineageColumn(occupied, sizes, anchor)
    // 竖条放不下时**不留半截计划**：整体退回网格分配（宁可落在视野里，也不与既有图重叠）
    if (column) return column
  }
  return allocateSlots(occupied, sizes, origin)
}

/** 竖向找空档的尝试上限：每次至少下移一个「冲突矩形 + 间隙」。
 * 超限即认定这一竖条被占满（异常形态），返回 null 让调用方退回网格分配 —— 不能无上限循环。 */
const LINEAGE_MAX_TRIES = 64

/**
 * 血缘列落位（用户 2026-09-24 裁决）：把本轮的 N 个槽位排到**锚点图右侧的一列**上，
 * 列顶与锚点顶边对齐；该竖条已被占就整体下移，形成「同代同列、往下续」。
 *
 * 为什么是一列而不是原来的 4 列网格：生成是「以某张图续作」，产物就该挨着它，
 * 而不是从视野左上角另起一片。这也正是「按血缘整理」里同一轮次的模样。
 *
 * 列内步长用**固定的 `SLOT_STEP`**，而不是树形布局的 48 间距：计划槽按**请求尺寸**算，
 * 出图比例可以不同（请求 1536×1024 → 占位高 160，网关返回 1024×1024 → 实际高 240）。
 * 固定步长（280 ≥ 240 显示上限 + 40）才保证「实际比占位高」时同列两张也不压图；
 * 若按占位尺寸累加（160 + 40 = 200），横图那一轮的同列下一张会压 40px，落位前的相交校验
 * 就会把第二张甩回视野左上角 —— 正是这次要修的现象。
 * 代价：刚生成完的列比「按血缘整理」松一点（点一次整理即收紧）。
 *
 * 返回 `null` = 这一竖条放不下（连续 `LINEAGE_MAX_TRIES` 次都被占），由调用方退回网格分配。
 */
export function planLineageColumn(
  occupied: readonly CanvasRect[],
  sizes: readonly { width: number; height: number }[],
  anchor: CanvasRect
): CanvasRect[] | null {
  if (sizes.length === 0) return null
  const x = anchor.x + anchor.w + LINEAGE_COL_GAP
  let y = anchor.y
  for (let tries = 0; tries < LINEAGE_MAX_TRIES; tries += 1) {
    // ⚠️ 冲突判定按**格子**（`SLOT_W` = 显示尺寸上限），不按占位尺寸：出图比例可与请求不同
    // （请求 1536×1024 → 占位 240×160，网关返回 1024×1024 → 实际 240×240）。按占位判会漏掉
    // 「实际比占位大」的那条边 —— 落位前 worker 拿**真实尺寸**复核就判冲突、把图甩回视野左上角，
    // 正是这次要修的现象。格子是任何出图尺寸的上界，按它判出来的计划恒不压图。
    // 代价：非方图请求时判定偏保守（可能让过一个本就放得下的位置），只影响位置高低，不影响正确性。
    // 竖向同样用格子：末张底边 = 首张顶边 + (n−1) 步长 + 格子高。
    const bottom = y + (sizes.length - 1) * SLOT_STEP + SLOT_W
    const hits = occupied.filter((r) => r.x < x + SLOT_W && x < r.x + r.w && r.y < bottom && y < r.y + r.h)
    if (hits.length === 0) return sizes.map((s, i) => ({ x, y: y + i * SLOT_STEP, w: s.width, h: s.height }))
    // 让过**所有**冲突矩形的底边（不是第一个）：同父的第二次生成因此落在上一批的整段下方
    y = Math.max(...hits.map((r) => r.y + r.h)) + SLOT_GAP
  }
  return null
}
