/**
 * 血缘与版本链推导（纯函数，不新增表）。
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
