/**
 * 生成任务的终态回执（纯函数）。
 *
 * 为什么抽成纯函数：单测环境是 node（无 jsdom），组件里的 DOM 路径测不到；而「该不该提示、
 * 提示什么」恰恰是这块最需要被钉住的判定。
 *
 * 为什么文案与当前任务路径共用同一份：当前任务的状态迁移由 `watchTopic` → `applyDetail` 提示，
 * 后台任务由任务列表级监看提示。两处各写一份文案，改一处必漏另一处。
 */
import type { TopicDetail } from '@motif/core'

/** 进行中的任务态。终态由 message 携带，topic 自己会回到 `idle` */
const BUSY_TOPIC_STATUSES = new Set(['pending', 'running', 'canceling'])

export function isBusyStatus(s: string | undefined): boolean {
  return typeof s === 'string' && BUSY_TOPIC_STATUSES.has(s)
}

/**
 * 从「在跑」落到「不在跑」= 一次真正的结束。
 *
 * ⚠️ `prev === undefined` 必须返回 false：那是「第一次见到的任务」（含首屏加载时早已结束的历史任务），
 * 提示它等于把历史当新闻播一遍。
 */
export function leftBusy(prev: string | undefined, next: string): boolean {
  return isBusyStatus(prev) && !isBusyStatus(next)
}

export interface TerminalNotice {
  tone: 'success' | 'danger' | 'info'
  message: string
  timeoutMs?: number
}

/**
 * 取「这一轮」的消息：`activeMessageId` 在终态会被置空，故回退到最后一条
 * （与 `Workspace` 里既有的取法一致；detail 的 messages 按 created_at 升序，最后一条即最新）。
 *
 * 导出供 `Workspace` 的迁移判定共用：两处各算一遍，将来改一处就会「判定用 A 消息、文案用 B 消息」。
 */
export function activeMessage(detail: TopicDetail) {
  return (
    detail.messages.find((m) => m.id === detail.topic.activeMessageId) ??
    detail.messages[detail.messages.length - 1]
  )
}

/**
 * 终态回执文案；无话可说时返回 `null`（不硬凑）。
 *
 * `title` 传入时前缀「任务「X」」—— 用于**非当前任务**的回执（当前任务不必点名自己）。
 * 不传 `title` 时输出与既有 toast 文案逐字一致。
 */
export function terminalNotice(detail: TopicDetail, opts?: { title?: string }): TerminalNotice | null {
  const msg = activeMessage(detail)
  // messages 为空：绝不能读 undefined.status（「造一个没有消息的进行态任务」是实测里最容易造出来的状态）
  if (!msg) return null
  const prefix = opts?.title ? `任务「${opts.title}」` : ''
  // ⚠️ 这里的「✓」是**有意保留**的：test/topic-notice.test.ts 逐字固定了该文案，
  // 且改动它属于改用户可见文案而非图标化，故不在本次范围内顺手改（见 PR 说明的「已知未改」）。
  if (msg.status === 'completed') return { tone: 'success', message: `${prefix}生成完成 ✓` }
  if (msg.status === 'failed') {
    return { tone: 'danger', message: `${prefix}生成失败：${msg.error ?? '未知原因'}。`, timeoutMs: 6000 }
  }
  if (msg.status === 'canceled') {
    const done = detail.canvasImages.filter((i) => i.messageId === msg.id).length
    const refund = msg.requestedCount - done
    // 一张都没少扣就没什么可退的，别提示
    if (refund <= 0) return null
    // ⚠️ 带任务名时正文不再重复「任务」二字，否则会读成「任务「海报」任务已取消，…」；
    // 不带任务名时保持既有文案逐字不变
    const body = opts?.title ? '已取消' : '任务已取消'
    return { tone: 'info', message: `${prefix}${body}，未完成的 ${refund} 张额度已退回。`, timeoutMs: 6000 }
  }
  return null
}

export interface TopicStatusRow {
  id: string
  title: string
  status: string
}

export interface TopicNoticePlan {
  /** 该发回执的任务（非当前任务、且刚从「在跑」落到「不在跑」） */
  finished: Array<{ id: string; title: string }>
  /** 下一份状态快照：调用方写回自己的 ref */
  next: Map<string, string>
}

/**
 * 任务列表级的回执判定（纯函数）。
 *
 * 把「该提示哪些任务」从组件里搬出来，是因为它决定了三条最要紧的行为，而组件路径在
 * `environment: 'node'`（无 jsdom）下测不到：**首屏不提示历史**、**同一次迁移只提示一次**、
 * **当前任务不重复提示**（它的迁移由 `watchTopic` → `applyDetail` 负责）。
 *
 * 调用方必须把返回的 `next` 写回自己的状态快照：这就是「只提示一次」的载体。
 */
export function planTopicNotices(input: {
  prev: ReadonlyMap<string, string>
  topics: readonly TopicStatusRow[]
  activeId: string | null
}): TopicNoticePlan {
  const finished: Array<{ id: string; title: string }> = []
  for (const t of input.topics) {
    if (t.id === input.activeId) continue
    if (!leftBusy(input.prev.get(t.id), t.status)) continue
    finished.push({ id: t.id, title: t.title })
  }
  return { finished, next: new Map(input.topics.map((t) => [t.id, t.status])) }
}
