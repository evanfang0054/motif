/**
 * 血缘（lineage）与版本链推导（纯函数，不新增表）。
 *
 * 命名口径：**UI 上叫「溯源」**（用户 2026-09-21 裁决：provenance 更白话、也更短），
 * 代码里沿用 `lineage` 这个标识符（英文里它是数据/ML 领域的标准词，且不必动 12 个标识符）。
 *
 * 参考 `.infinite-canvas-ref/src/lib/canvas/canvas-resource-references.ts` 的思路
 * （从节点元数据反查引用关系）。
 * 适配改动：Motif 不存连线，靠既有两跳数据推导 ——
 *   图片 B 的 message_id → 该 message 的 reference_ids 含 A ⇒ A → B
 *   同一 message 的产出天然是一组（批量聚簇）
 *   同一 message 的产出按 serial 排序即版本链
 * 这正是「不存可推导字段」原则的落点：零新表、零新列。
 */

export interface LineageImage {
  id: string
  messageId: string | null
  serial: number
  origin: 'generated' | 'uploaded'
}

export interface LineageMessage {
  id: string
  referenceIds: string[]
}

export interface LineageEdge {
  from: string
  to: string
}

export interface Lineage {
  /** 血缘连线（去重、忽略自引用与不存在的图） */
  edges: LineageEdge[]
  /** 版本链：同一 message 的产出按 serial 升序 */
  chains: Array<{ messageId: string; imageIds: string[] }>
  /** 血缘根：origin='uploaded' 且无上游 */
  roots: string[]
}

export function deriveLineage(input: { images: LineageImage[]; messages: LineageMessage[] }): Lineage {
  const known = new Set(input.images.map((i) => i.id))
  const refsByMessage = new Map(input.messages.map((m) => [m.id, m.referenceIds ?? []]))

  const edges: LineageEdge[] = []
  const seen = new Set<string>()
  for (const image of input.images) {
    if (!image.messageId) continue
    for (const refId of refsByMessage.get(image.messageId) ?? []) {
      if (!known.has(refId) || refId === image.id) continue
      const key = `${refId}\u0000${image.id}`
      if (seen.has(key)) continue
      seen.add(key)
      edges.push({ from: refId, to: image.id })
    }
  }

  const grouped = new Map<string, LineageImage[]>()
  for (const image of input.images) {
    if (!image.messageId) continue
    const list = grouped.get(image.messageId)
    if (list) list.push(image)
    else grouped.set(image.messageId, [image])
  }
  const chains = [...grouped.entries()].map(([messageId, list]) => ({
    messageId,
    imageIds: [...list].sort((a, b) => a.serial - b.serial).map((i) => i.id),
  }))

  // 用真值判定（与上面两处 `if (!image.messageId)` 一致）：`undefined` / `''` 同样是
  // 「没有上游」—— 若写成 `=== null`，JSON round-trip 或未来的 mapper 产出 undefined 时
  // 会静默漏掉一个合法血缘根
  const roots = input.images.filter((i) => i.origin === 'uploaded' && !i.messageId).map((i) => i.id)

  return { edges, chains, roots }
}

// ---------- 渲染用的几何与图层模型 ----------
// 与推导同文件：两者都由 message_id / reference_ids 推导而来；判定收在纯函数里，
// 组件只负责把结果画出来（单测环境无 jsdom，写在组件里等于零覆盖）。

/** 世界坐标矩形：直接用几何内核里的同一个类型（不另立同形接口，免得将来加字段两边漂移） */
export type { Rect } from './geometry'
type Rect = import('./geometry').Rect

/** 控制点外推的上下限（世界单位）：太近会塌成直线，太远会甩出画布 */
const EDGE_MIN_CONTROL = 24
const EDGE_MAX_CONTROL = 120
/** 分组框的屏幕内边距（世界单位 = 该值 / 缩放比，保证屏幕观感恒定） */
const GROUP_PADDING = 16

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

/** 控制点外推距离：0.4 倍主轴间距，钳在 24–120 之间，且不超过间距的 1/4（否则曲线会鼓出卡片外） */
function controlOffset(distance: number): number {
  return Math.min(clamp(distance * 0.4, EDGE_MIN_CONTROL, EDGE_MAX_CONTROL), distance / 4)
}

/** 保留两位小数：路径字符串要稳定（浮点尾巴会让断言与 diff 变成噪声） */
function r2(v: number): number {
  return Math.round(v * 100) / 100
}

/**
 * 血缘连线：按两端中心位移的**主轴**选「面对面」的两条边，连成三次贝塞尔。
 *
 * 起点/终点恒落在矩形的边上（贴面由主轴决定，与两框相对位置无关）；同输入恒同输出。
 *
 * 控制点外推 `min(clamp(主轴间距 × 0.4, 24, 120), 主轴间距 / 4)`：后半截是必要的 ——
 * 只取前者的下限 24 时，间距比 96 还小时控制点会甩到对侧之外，曲线在两卡之间鼓出去一小段。
 */
export function edgePath(from: Rect, to: Rect): string {
  const fx = from.x + from.w / 2
  const fy = from.y + from.h / 2
  const tx = to.x + to.w / 2
  const ty = to.y + to.h / 2
  const dx = tx - fx
  const dy = ty - fy

  if (Math.abs(dx) >= Math.abs(dy)) {
    const sign = dx >= 0 ? 1 : -1
    const sx = sign > 0 ? from.x + from.w : from.x
    const ex = sign > 0 ? to.x : to.x + to.w
    const c = controlOffset(Math.abs(dx)) * sign
    return `M ${r2(sx)} ${r2(fy)} C ${r2(sx + c)} ${r2(fy)}, ${r2(ex - c)} ${r2(ty)}, ${r2(ex)} ${r2(ty)}`
  }

  const sign = dy >= 0 ? 1 : -1
  const sy = sign > 0 ? from.y + from.h : from.y
  const ey = sign > 0 ? to.y : to.y + to.h
  const c = controlOffset(Math.abs(dy)) * sign
  return `M ${r2(fx)} ${r2(sy)} C ${r2(fx)} ${r2(sy + c)}, ${r2(tx)} ${r2(ey - c)}, ${r2(tx)} ${r2(ey)}`
}

/** 同轮次分组框：成员矩形并集 + 恒定**屏幕**内边距（世界单位 = padding / k）；空输入返回 null */
export function chainBounds(rects: readonly Rect[], k: number, padding = GROUP_PADDING): Rect | null {
  if (rects.length === 0) return null
  const pad = padding / (k > 0 ? k : 1)
  const left = Math.min(...rects.map((r) => r.x))
  const top = Math.min(...rects.map((r) => r.y))
  const right = Math.max(...rects.map((r) => r.x + r.w))
  const bottom = Math.max(...rects.map((r) => r.y + r.h))
  return { x: left - pad, y: top - pad, w: right - left + pad * 2, h: bottom - top + pad * 2 }
}

export interface LineageLayer {
  /** `key` = `${from}\0${to}` */
  edges: Array<{ key: string; d: string }>
  /** `key` = messageId；`label` = `同一轮 · N 张` */
  groups: Array<{ key: string; rect: Rect; label: string }>
}

/**
 * 把「血缘推导 + 摆放表 + 缩放比」摊成「画什么」。返回 `null` 表示整层都不该挂载。
 *
 * - 边：两端都有摆放才产出（位置表是稀疏的，推导只保证 id 属于本任务）
 * - 分组框：该轮次成员**全部**有摆放且 ≥2 张才产出 —— 否则标签里的张数与实际画出来的方块数不符
 */
export function lineageLayerModel(input: {
  lineage: Lineage
  placements: Record<string, Rect | undefined>
  k: number
}): LineageLayer | null {
  const { lineage, placements, k } = input

  const edges: LineageLayer['edges'] = []
  for (const e of lineage.edges) {
    const from = placements[e.from]
    const to = placements[e.to]
    if (!from || !to) continue
    edges.push({ key: `${e.from}\u0000${e.to}`, d: edgePath(from, to) })
  }

  const groups: LineageLayer['groups'] = []
  for (const chain of lineage.chains) {
    if (chain.imageIds.length < 2) continue
    const rects = chain.imageIds.map((id) => placements[id])
    if (rects.some((r) => !r)) continue
    const rect = chainBounds(rects as Rect[], k)
    if (!rect) continue
    groups.push({ key: chain.messageId, rect, label: `同一轮 · ${chain.imageIds.length} 张` })
  }

  if (edges.length === 0 && groups.length === 0) return null
  return { edges, groups }
}

// ---------- 按血缘铺开（树形布局） ----------

export interface TreeLayoutImage {
  id: string
  messageId: string | null
  serial: number
  /** 画布上的显示尺寸（世界单位）；形状与 `@motif/core` 的 `displaySize` 返回值一致 */
  size: { width: number; height: number }
}

export interface TreeLayoutOptions {
  /** 列间距（世界单位） */
  colGap?: number
  /** 同列内的行间距 */
  rowGap?: number
}

const TREE_COL_GAP = 120
const TREE_ROW_GAP = 48

/**
 * 把图按血缘排成**从左到右的分层树**：没有上游的在最左列，每一列是同一代；
 * 同一轮产出天然同代，且在列内按 `serial` 连续堆叠（正好让版本链并排）。
 *
 * - 列内顺序用父节点在上一列的位置（重心）排一遍，减少连线交叉；列 0 按 `serial`。
 * - 每列在竖直方向以 `origin.y` 居中，故整棵树围绕 `origin` 展开。
 * - 血缘若有环（理论上不该有），按「就地归零」处理，不递归、不抛错。
 *
 * 纯函数：只算位置，不碰 store、不落库（撤销栈与防抖提交由调用方走既有管线）。
 */
export function layoutLineageTree(input: {
  images: readonly TreeLayoutImage[]
  lineage: Lineage
  origin: { x: number; y: number }
  options?: TreeLayoutOptions
}): Array<{ id: string; rect: Rect }> {
  const colGap = input.options?.colGap ?? TREE_COL_GAP
  const rowGap = input.options?.rowGap ?? TREE_ROW_GAP
  if (input.images.length === 0) return []

  const byId = new Map(input.images.map((i) => [i.id, i]))
  const parents = new Map<string, string[]>()
  for (const e of input.lineage.edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue
    const list = parents.get(e.to)
    if (list) {
      if (!list.includes(e.from)) list.push(e.from)
    } else {
      parents.set(e.to, [e.from])
    }
  }

  // 代数（最长路径）：父节点代数 +1；环就地归零
  const depth = new Map<string, number>()
  const visiting = new Set<string>()
  const depthOf = (id: string): number => {
    const known = depth.get(id)
    if (known !== undefined) return known
    if (visiting.has(id)) return 0
    visiting.add(id)
    const ps = parents.get(id) ?? []
    const d = ps.length === 0 ? 0 : 1 + Math.max(...ps.map(depthOf))
    visiting.delete(id)
    depth.set(id, d)
    return d
  }
  for (const img of input.images) depthOf(img.id)

  // 分列
  const columns: TreeLayoutImage[][] = []
  for (const img of input.images) {
    const d = depth.get(img.id) ?? 0
    ;(columns[d] ??= []).push(img)
  }

  // 列内排序：列 0 按 serial；其余按「父节点在上一列的序号」的重心，再按 serial
  const orderInPrev = new Map<string, number>()
  const rects = new Map<string, Rect>()
  let colX = input.origin.x

  columns.forEach((col, index) => {
    if (index > 0) {
      col.sort((a, b) => {
        const bary = (img: TreeLayoutImage) => {
          const ps = (parents.get(img.id) ?? []).map((p) => orderInPrev.get(p)).filter((v): v is number => v !== undefined)
          return ps.length === 0 ? Number.MAX_SAFE_INTEGER : ps.reduce((s, v) => s + v, 0) / ps.length
        }
        const ba = bary(a)
        const bb = bary(b)
        if (ba !== bb) return ba - bb
        return a.serial - b.serial
      })
    } else {
      col.sort((a, b) => a.serial - b.serial)
    }
    col.forEach((img, i) => orderInPrev.set(img.id, i))

    const colW = Math.max(...col.map((i) => i.size.width))
    const totalH = col.reduce((s, i) => s + i.size.height, 0) + rowGap * (col.length - 1)
    let y = input.origin.y - totalH / 2
    for (const img of col) {
      rects.set(img.id, { x: colX, y, w: img.size.width, h: img.size.height })
      y += img.size.height + rowGap
    }
    colX += colW + colGap
  })

  return input.images.flatMap((img) => {
    const rect = rects.get(img.id)
    return rect ? [{ id: img.id, rect }] : []
  })
}

/**
 * 目标摆放是否与当前摆放一致（默认容差 1px）。
 *
 * 传一个较大的容差（组件里用 80）时，它同时是「当前摆放与血缘布局差得多不多」的判据 ——
 * 与树形布局的偏差在容差内视为「已经排好了」，不必再提示整理。
 *
 * 用途：**引导提示的去抖**。极端形状（如血缘成环）下 `needsTreeLayout` 可能永远为真，
 * 而「整理完还是它自己」说明没什么可整理的 —— 此时不该再提示。
 * 它同时让「按血缘整理」**幂等**：树形布局的 origin 锚在内容包围盒上（不随视口漂移），
 * 故再点一次算出来的计划与当前摆放逐值相同。
 */
export function isSameLayout(
  plan: readonly { id: string; rect: Rect }[],
  placements: Record<string, Rect | undefined>,
  tolerance = 1
): boolean {
  if (plan.length === 0) return true
  for (const p of plan) {
    const cur = placements[p.id]
    if (!cur) return false
    if (Math.abs(cur.x - p.rect.x) > tolerance) return false
    if (Math.abs(cur.y - p.rect.y) > tolerance) return false
    if (Math.abs(cur.w - p.rect.w) > tolerance) return false
    if (Math.abs(cur.h - p.rect.h) > tolerance) return false
  }
  return true
}

