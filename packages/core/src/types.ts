/** Motif 领域类型 —— 与服务端 API 契约保持一致 */

export type UserRole = 'user' | 'admin' | 'root'

/** 账号启用状态：禁用后不可登录，既有会话失效；不影响正在执行的生成轮次 */
export type UserStatus = 'active' | 'disabled'

export interface User {
  id: string
  email: string
  name: string
  avatarUrl: string | null
  role: UserRole
  status: UserStatus
  /** 由引导创建或管理员重置密码后置真：仅作顶栏软提示，不拦截请求 */
  mustChangePassword: boolean
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
  /** 暂存参考图（上传后未生成的） */
  staged?: StagedReference[]
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
  /** 当前支付渠道：mock=模拟收银台；epay/stripe=真实渠道（客户端据此切文案） */
  channel?: 'mock' | 'epay' | 'stripe'
}

/** 暂存参考图：上传后先入暂存表（不进画布），点开始生成时才转正为画布图并参与生成 */
export interface StagedReference {
  id: string
  topicId: string
  name: string
  imageKey: string
  mimeType: string
  bytes: number
  createdAt: string
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

/**
 * 额度变动的来源。**每一次 `users.credits` 的变动都必须能在 `credit_ledger` 里找到一条带来源的记录** ——
 * 这是「账目与余额一致」这条不变式的前提，也是概览看板所有额度口径的唯一依据。
 */
export type CreditSource =
  | 'opening_balance' // 建档/迁移时的初始额度（迁移与测试造数）
  | 'signup_bonus'
  | 'invite_reward'
  | 'order_paid'
  | 'cdk_redeem'
  | 'admin_adjust'
  | 'generation_charge'
  | 'generation_refund'
