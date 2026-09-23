/**
 * 「重试失败的生成轮次」的表单预填计划（纯函数）。
 *
 * 为什么抽成纯函数：单测环境是 node（无 jsdom），组件里的点击路径测不到；
 * 而「重试要还原成什么」恰恰是这条改动最需要钉住的判定 —— 还原错了就是花着用户的额度
 * 跑一轮与失败那轮不同的生成（张数少算 / 尺寸被悄悄改成默认 / 参考图全丢）。
 *
 * 与「以它为参考再生成」（`lib/canvas/regenerate.ts`）的区别：
 * 那条是**预填**、由用户改完自己提交；这条是**重试**，预填后直接重新提交（见 CONTEXT 的 _Avoid_）。
 */
import { ALLOWED_SIZES, clampCount, validateSize, type Message } from '@motif/core'

/** 面板级尺寸：预设 key / `'auto'` / `'custom'`（与 `PanelState.size` 同一口径） */
export interface RetryPlan {
  prompt: string
  count: number
  size: string
  customW: number
  customH: number
  /** 仍存在的画布参考图 id（已删掉的会被摘掉，否则提交必然 400） */
  referenceIds: string[]
}

/** 自定义宽高的默认值：与 `Workspace` 的 `IDLE_PANEL.customW/H` 一致 */
const DEFAULT_CUSTOM_PX = 1024

/**
 * 把一条失败消息还原成表单状态。
 *
 * - `prompt` 用**原始提示词**（`message.prompt`）而不是 `finalPrompt`：提交时服务端会按
 *   `publicCtx.llmEnhanceEnabled` 再叠一次增强，用 finalPrompt 会把上一轮的增强结果当原文再增强一遍。
 * - `size` 是预设 / auto 就原样回填；其余交给核心库的 `validateSize` 判 —— **不自己再写一份解析**。
 *   它同时是服务端 `POST /api/generate-images` 的判据，复用它才能保证「重试提交的尺寸
 *   一定是服务端会接受的形状」；判不通过（历史脏数据）时回退 `'auto'`，与面板默认值一致。
 * - `referenceIds` 先按当前画布图集合过滤：失败那轮引用过的图可能已被删除，
 *   残留 id 会让下一次提交直接 400「参考图不存在或不属于当前任务」。
 *   同时**按 id 去重**：服务端把参考图按「条数」计入上限（同一张重复提交也各算一条，
 *   见 `generate-refs-cap.test.ts`），重试携带重复 id 会平白把 5 张的名额占满。
 */
export function planRetryFromMessage(input: {
  message: Pick<Message, 'prompt' | 'size' | 'requestedCount' | 'referenceIds'>
  /** 当前任务里仍然存在的画布图 id */
  canvasImageIds: readonly string[]
}): RetryPlan {
  const { message } = input
  const alive = new Set(input.canvasImageIds)
  const base = {
    prompt: message.prompt,
    count: clampCount(message.requestedCount),
    customW: DEFAULT_CUSTOM_PX,
    customH: DEFAULT_CUSTOM_PX,
    referenceIds: [...new Set(message.referenceIds)].filter((id) => alive.has(id)),
  }

  if (message.size === 'auto' || (ALLOWED_SIZES as readonly string[]).includes(message.size)) {
    return { ...base, size: message.size }
  }

  const validated = validateSize(message.size)
  if (!validated.ok) return { ...base, size: 'auto' }

  // `validateSize` 通过时 value 已归一成 `宽x高`，这里只需拆成两个数字框
  const [w, h] = validated.value.split('x').map(Number)
  return { ...base, size: 'custom', customW: w, customH: h }
}
