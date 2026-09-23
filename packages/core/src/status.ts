import type { MessageStatus, TopicStatus } from './types'

/** 话题状态展示映射（前端徽标文案） */
export const TOPIC_STATUS_LABEL: Record<TopicStatus, string> = {
  idle: '空闲',
  pending: '排队中',
  running: '生成中',
  canceling: '正在停止生成',
  completed: '已完成',
  failed: '生成失败',
  canceled: '已取消',
}

export const MESSAGE_STATUS_LABEL: Record<MessageStatus, string> = {
  queued: '排队中',
  running: '生成中',
  completed: '已完成',
  canceling: '正在停止生成',
  canceled: '已取消',
  failed: '生成失败',
}

/**
 * 话题活跃状态：idle 表示没有进行中的任务；
 * 任务入队后经历 pending → running →（canceling）→ 回到 idle，
 * 终态信息由 message 自身携带。
 */
export function topicStatusFromMessage(msg: MessageStatus | null): TopicStatus {
  if (msg === 'queued') return 'pending'
  if (msg === 'running') return 'running'
  if (msg === 'canceling') return 'canceling'
  return 'idle'
}

/** 允许取消的执行中状态 */
export function isCancelableMessageStatus(s: MessageStatus): boolean {
  return s === 'queued' || s === 'running'
}

/**
 * 进行中的话题态（「这个任务现在有没有在跑」）。
 *
 * ⚠️ 这是**唯一**一份定义，UI 的徽标/按钮判定与 DB 的读取自愈判据都必须用它 ——
 * 自愈的前提正是「活跃消息已不在跑」，若两边各写一份、将来改一处，就会出现
 * 「自愈把一个 UI 仍认为在跑的任务 settle 掉」这类只在一侧可见的错误。
 *
 * 终态由 message 携带，topic 自己会回到 `idle`，故终态三态不在本集合内。
 */
const BUSY_TOPIC_STATUSES = ['pending', 'running', 'canceling'] as const

export function isBusyTopicStatus(s: string | undefined | null): boolean {
  return typeof s === 'string' && (BUSY_TOPIC_STATUSES as readonly string[]).includes(s)
}

/**
 * 「在跑」话题态的字面清单，供需要拼 SQL 的调用方（读取自愈的 WHERE 条件）使用。
 * 直接导出数组而不是让调用方自己抄一份，是为了让 SQL 与 `isBusyTopicStatus` **不可能漂移**。
 */
export const BUSY_TOPIC_STATUS_VALUES: readonly string[] = BUSY_TOPIC_STATUSES

/**
 * 每个消息状态是否让 topic 保持「在跑」。
 *
 * ⚠️ 刻意写成 `Record<MessageStatus, boolean>` 而**不是**「手写数组 + filter」：
 * 给 `MessageStatus` 加一个态时，这里会**编译失败**，逼人明确回答「新态算不算在跑」。
 * 若用数组，新态会被静默过滤掉 ⇒ 不在 ACTIVE 集合内 ⇒ 读取自愈认为「活跃消息已不在跑」
 * ⇒ **把一个真正在跑的任务 settle 掉**。这正是本模块最怕的失效模式，故交给编译器守。
 *
 * 取值必须与 `topicStatusFromMessage` 同源；`core.test.ts` 有一条断言把两者钉在一起。
 */
const MESSAGE_STATUS_IS_ACTIVE: Record<MessageStatus, boolean> = {
  queued: true,
  running: true,
  canceling: true,
  completed: false,
  failed: false,
  canceled: false,
}

export const ACTIVE_MESSAGE_STATUS_VALUES: readonly MessageStatus[] = (
  Object.keys(MESSAGE_STATUS_IS_ACTIVE) as MessageStatus[]
).filter((s) => MESSAGE_STATUS_IS_ACTIVE[s])
