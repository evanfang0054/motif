/**
 * 参考图准入规则 —— 纯函数，服务端与客户端共用。
 *
 * 「上传参考图」与画布「@ 引用」写入的是**同一个参考图列表**，故共用同一个上限：
 * 上传 5 张、或引用 5 张、或上传 3 张 + 引用 2 张，都到顶。
 */

/** 参考图上限（张） */
export const MAX_REFERENCE_IMAGES = 5

export interface ReferenceAddPlan {
  /** 本次准入的 id（保持传入顺序；已剔除重复） */
  accepted: string[]
  /** 因已在参考图列表里而跳过的 id */
  alreadyReferenced: string[]
  /** 因超出上限而拒绝的 id */
  rejected: string[]
}

/**
 * 逐张准入：把 incoming 依次塞进 current，塞满 max 为止。
 *
 * 刻意按「一张一张加」建模 —— 用户既可能逐张点「@ 引用」，也可能框选一批，
 * 两种操作必须是同一条规则：批量等价于「按顺序逐张加」，故超限时**靠前的先进、靠后的被拒**，
 * 而不是整批一起失败（否则用户框选 6 张会连本来能加的 3 张也加不进去）。
 */
export function planReferenceAdd(
  current: readonly string[],
  incoming: readonly string[],
  max: number = MAX_REFERENCE_IMAGES
): ReferenceAddPlan {
  const accepted: string[] = []
  const alreadyReferenced: string[] = []
  const rejected: string[] = []
  const seen = new Set(current)
  let room = Math.max(0, max - current.length)

  for (const id of incoming) {
    // 已在列表里（含本次 incoming 内的重复）：跳过而不是拒满，文案要能区分这两种原因
    if (seen.has(id)) {
      alreadyReferenced.push(id)
      continue
    }
    if (room <= 0) {
      rejected.push(id)
      continue
    }
    seen.add(id)
    accepted.push(id)
    room--
  }

  return { accepted, alreadyReferenced, rejected }
}

/** 参考图数量校验（服务端兜底用） */
export function validateReferenceCount(count: number): string | null {
  if (!Number.isInteger(count) || count < 0) return '参考图数量不合法。'
  if (count > MAX_REFERENCE_IMAGES) return `参考图最多 ${MAX_REFERENCE_IMAGES} 张。`
  return null
}
