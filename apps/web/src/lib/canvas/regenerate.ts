/**
 * 「以它为参考再生成」的预填计算（纯函数）。
 *
 * 语义 = **以图续作**：把该图**所属轮次的原始提示词**填回表单，并把参考图换成这张图本身。
 * 与画布上的「@ 引用」的关键区别是**替换**（而不是追加）画布引用。
 *
 * 为什么判定收进纯函数：单测环境是 node（无 jsdom），组件里的路径测不到；而「填什么、
 * 什么时候整体不生效」恰恰是这块最需要被钉住的判定。
 */

/** 机器追加的参考句（与画布「@ 引用」写进提示词的那一句完全一致）；只认它，不做模糊匹配。
 *  编号取 `\d{3,}`：写入端是 `padStart(3)`，序号到四位时仍要能剥掉（不然会残留旧句再追加新句）。 */
const AUTO_REFERENCE_SENTENCE = /#\d{3,} 作为参考图保持主体一致。/g

/**
 * 去掉机器追加的参考句，并收敛多余空白。
 *
 * 只认上面那一种精确句式：用户手写的相近文字（「#003 参考一下」、位数不符的编号）一律不动 ——
 * 宁可少剥，不可多剥。
 */
export function stripAutoReferenceSentences(prompt: string): string {
  return prompt.replace(AUTO_REFERENCE_SENTENCE, ' ').replace(/\s+/g, ' ').trim()
}

export interface RegenerateInput {
  image: { id: string; serial: number; messageId: string | null }
  messages: Array<{ id: string; prompt: string }>
  /** 面板当前提示词：找不到该图所属轮次时**原样返回它**（「一个字都不动」的载体） */
  currentPrompt: string
  /** 暂存参考（上传后未生成的）：**保留**，它们会被一起提交 */
  stagedIds: string[]
  maxReferences: number
}

export type RegeneratePlan =
  | { ok: true; prompt: string; referenceIds: string[]; reusedPrompt: boolean }
  | { ok: false; reason: 'cap' }

export function planRegenerateFromImage(input: RegenerateInput): RegeneratePlan {
  // 先校验后产出：超上限就整体不生效，绝不出现「提示词换了、参考图没换」的半截状态
  if (input.stagedIds.length + 1 > input.maxReferences) return { ok: false, reason: 'cap' }

  // 只替换**画布引用**：暂存参考是「已上传、待转正」的上传件，一并清掉会让面板出现
  // 「暂存区列着 N 张但不会被提交」的假陈述
  const referenceIds = [...input.stagedIds, input.image.id]

  // `messageId` 为 null（上传图）与「该轮次已被日志清理删掉」都落到这里：
  // 没有可复用的提示词，就一个字都不动
  const source = input.image.messageId
    ? input.messages.find((m) => m.id === input.image.messageId)
    : undefined
  if (!source) return { ok: true, prompt: input.currentPrompt, referenceIds, reusedPrompt: false }

  const marker = `#${String(input.image.serial).padStart(3, '0')}`
  const base = stripAutoReferenceSentences(source.prompt)
  return {
    ok: true,
    prompt: `${base ? `${base} ` : ''}${marker} 作为参考图保持主体一致。`,
    referenceIds,
    reusedPrompt: true,
  }
}
