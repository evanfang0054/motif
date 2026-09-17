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
