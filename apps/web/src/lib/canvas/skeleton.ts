/**
 * 待生成骨架槽（#88）：从「服务端下发的槽位计划 + 每轮已落库张数」推出画布上该渲染的骨架。
 *
 * 为什么做成纯函数：这是「骨架数 = 未产出张数」这条验收不变式的**唯一判据**，
 * 抽出来才能单测钉住（组件里各写一遍，将来改一处必漏另一处）。
 *
 * 骨架**不是画布图片**（不进 `placements` / `images`），故天然不参与选中、框选、删除、
 * 灯箱、归档导出、「N 张图片」统计与整理布局 —— 这些路径读的都是图片集合，与骨架无交集。
 */

import { ACTIVE_MESSAGE_STATUS_VALUES, isCanvasRect, type CanvasRect } from '@motif/core'

/** 骨架渲染所需的最小消息形状（不绑死完整 Message，便于测试直接构造） */
export interface SkeletonMessageSource {
  id: string
  status: string
  /**
   * 入队时服务端算好的槽位计划；第 i 项 ↔ 本轮第 i 张产出。
   *
   * ⚠️ **可选**：`slotPlan` 是 #88 才加的字段，而客户端静态资源与服务端 API 的版本
   * **可以错开**（滚动发布时新客户端配旧服务端；dev 下 runtime 单例也可能仍是旧模块）。
   * 对端没发这个字段时不能崩 —— 见 `planOf` 的兜底语义。
   */
  slotPlan?: CanvasRect[]
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
    const plan = planOf(m)
    const done = generatedCountByMessage[m.id] ?? 0
    for (let i = done; i < plan.length; i += 1) {
      const rect = plan[i]
      // ⚠️ 坏槽**跳过但保留原下标**（`i` 仍是「在计划里的位置」），而不是先把坏项 filter 掉再编号。
      // 真实差异只有两处，别写成「否则骨架会错位」—— 位置由 `rect` 自己携带（CanvasStage 用
      // `s.rect.*` 定位），`index` 只当 React key、`ordinal` 只当「正在生成第 N 张」的读屏文案，
      // 重编号不会让任何骨架移位：
      //   ① `ordinal` 会与真实批次位置脱节（第 3 张被说成第 2 张）；
      //   ② **`done` 边界处会少一个骨架** —— 若坏槽落在 `done` 之前，重编号后起点跟着前移，
      //      本该保留的槽被跳过（用例 `坏槽落在已产出区间之前` 钉住这条）。
      if (!isCanvasRect(rect)) continue
      out.push({ messageId: m.id, index: i, ordinal: i + 1, rect })
    }
  }
  return out
}

/**
 * 取槽位计划，**缺失 / 不是数组一律归到「没有计划」**（等价于 `slotPlan = []`）。
 *
 * 为什么必须兜这一道：`m.slotPlan.length` 在字段缺失时抛 TypeError，而调用点
 * （`Workspace` 的 `skeletons` useMemo）在**渲染期**求值 —— 一次字段缺失就是整个工作台白屏，
 * 而不是「少几个骨架」。客户端与服务端的版本错开是常态（滚动发布 / dev 旧 runtime 单例），
 * 不能假设对端一定发了新字段。
 *
 * 兜底**不引入新语义**：`slotPlan = []` 本来就有定义 —— 老消息没有计划时「不产出骨架、
 * 出图时走现场分配」（见 `server/services.ts` 的 `executeMessage`：`msg.slotPlan[i]` 取不到
 * 就回落 `allocateSlots`），所以「缺失」与「空数组」等价。
 *
 * 同时挡掉「不是数组」的脏数据：字符串 `'[]'` 也有 `.length`，会按字符下标产出坐标是
 * `'['` / `']'` 的骨架块，比没有骨架更糟。数组内**单个坏元素**由调用处的 `isCanvasRect` 挡。
 */
function planOf(m: SkeletonMessageSource): readonly CanvasRect[] {
  return Array.isArray(m.slotPlan) ? m.slotPlan : []
}
