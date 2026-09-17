/** Motif 领域类型 —— 与服务端 API 契约保持一致 */

export type UserRole = 'user' | 'admin'

export interface User {
  id: string
  email: string
  name: string
  avatarUrl: string | null
  role: UserRole
  credits: number
  inviteCode: string
  invitedCount: number
}

export type TopicStatus =
  | 'idle'
  | 'pending'
  | 'running'
  | 'canceling'
  | 'completed'
  | 'failed'
  | 'canceled'

export interface Topic {
  id: string
  userId: string
  title: string
  status: TopicStatus
  activeMessageId: string | null
  activePrompt: string | null
  createdAt: string
  updatedAt: string
}

export type MessageStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'canceling'
  | 'canceled'
  | 'failed'

export interface Message {
  id: string
  topicId: string
  userId: string
  prompt: string
  finalPrompt: string
  size: string
  requestedCount: number
  enhancePrompt: boolean
  /** 本轮生成引用的参考图 ID 列表（真实图生图 edits 输入） */
  referenceIds: string[]
  status: MessageStatus
  workerId: string | null
  lockedAt: string | null
  leaseToken: string | null
  leaseExpiresAt: string | null
  attempts: number
  error: string | null
  createdAt: string
}

export type CanvasImageOrigin = 'generated' | 'uploaded'

export interface CanvasImage {
  id: string
  topicId: string
  userId: string
  origin: CanvasImageOrigin
  serial: number
  name: string
  src: string
  imageKey: string
  mimeType: string
  bytes: number
  width: number
  height: number
  messageId: string | null
  createdAt: string
}

export interface TopicDetail {
  topic: Topic
  messages: Message[]
  canvasImages: CanvasImage[]
  messageReferences: number[]
}

export interface CreditPackage {
  id: string
  label: string
  credits: number
  amountTotal: number
  currency: string
}

export interface BillingPackagesResponse {
  packages: CreditPackage[]
  configured: boolean
}

/** 生成请求（POST /api/generate-images） */
export interface GenerateImagesInput {
  prompt: string
  count: number
  size: string
  enhance: boolean
  topicId: string | null
  referenceCanvasImageIds: string[]
}

/** 生成请求响应（HTTP 202） */
export interface GenerateImagesResponse {
  prompt: string
  topic: Topic
  messageId: string
  queued: boolean
  user: User
}
