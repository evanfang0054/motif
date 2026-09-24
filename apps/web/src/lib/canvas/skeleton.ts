/**
 * 待生成骨架槽（#88）：从「服务端下发的槽位计划 + 每轮已落库张数」推出画布上该渲染的骨架。
 *
 * 为什么做成纯函数：这是「骨架数 = 未产出张数」这条验收不变式的**唯一判据**，
 * 抽出来才能单测钉住（组件里各写一遍，将来改一处必漏另一处）。
 *
 * 骨架**不是画布图片**（不进 `placements` / `images`），故天然不参与选中、框选、删除、
 * 灯箱、归档导出、「N 张图片」统计与整理布局 —— 这些路径读的都是图片集合，与骨架无交集。
 */

import { ACTIVE_MESSAGE_STATUS_VALUES, type CanvasRect } from '@motif/core'

/** 骨架渲染所需的最小消息形状（不绑死完整 Message，便于测试直接构造） */
export interface SkeletonMessageSource {
  id: string
  status: string
  /** 入队时服务端算好的槽位计划；第 i 项 ↔ 本轮第 i 张产出 */
  slotPlan: CanvasRect[]
}

export interface PendingSkeleton {
  messageId: string
  /** 批次内 0-based 序号（与 worker 的 `indexInBatch` 对齐，出图落回同一槽） */
  index: number
  /** 面向用户的 1-based 序号，用于「正在生成第 N 张」可访问名 */
  ordinal: number
  rect: CanvasRect
}

/**
 * 推出待产出骨架。
 *
 * 不变式（#88 验收口径）：
 * 1. **骨架数 = 未产出张数** = `slotPlan.length − 已落库张数`；
 * 2. 只认活跃轮次（queued / running / canceling）—— 终态（完成 / 失败 / 取消）**一律不留骨架**，
 *    未产出的槽随退额一起摘掉，故「摘除数 = 退额数」；
 * 3. 已落库张数由调用方按 `messageId` 统计（`images` 里带 `messageId` 的生成图）。
 *
 * 多轮并存时按消息顺序拼接（正常只有一轮在跑；历史遗留的多活跃轮次也各自成组，不会串位）。
 */
export function pendingSkeletonSlots(
  messages: ReadonlyArray<SkeletonMessageSource>,
  generatedCountByMessage: Record<string, number>
): PendingSkeleton[] {
  const out: PendingSkeleton[] = []
  for (const m of messages) {
    // 终态不留骨架：与退额口径同源（退额 = requestedCount − 已落库张数）
    if (!(ACTIVE_MESSAGE_STATUS_VALUES as readonly string[]).includes(m.status)) continue
    const done = generatedCountByMessage[m.id] ?? 0
    for (let i = done; i < m.slotPlan.length; i += 1) {
      out.push({ messageId: m.id, index: i, ordinal: i + 1, rect: m.slotPlan[i] })
    }
  }
  return out
}
