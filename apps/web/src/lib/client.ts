'use client'

import type {
  BillingPackagesResponse,
  CanvasImage,
  CanvasMeta,
  CanvasPatch,
  CanvasSnapshot,
  GenerateImagesInput,
  GenerateImagesResponse,
  StagedReference,
  Topic,
  TopicDetail,
  User,
} from '@motif/core'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

/** 管理后台：CDK 行（状态由 redeemedBy / revokedAt 推导，接口不额外给 status 字段） */
export interface AdminCdk {
  code: string
  credits: number
  redeemedBy: string | null
  redeemedAt: string | null
  revokedAt: string | null
  createdAt: string
}

/** 管理后台：订单行。amountTotal 单位为「分」 */
export interface AdminOrder {
  id: string
  userId: string
  packageId: string
  credits: number
  amountTotal: number
  currency: string
  status: string
  createdAt: string
  paidAt: string | null
}

/** 管理后台：概览指标。字段必须与 `packages/db` 的 `AdminOverview` 逐一对齐 */
export interface AdminOverview {
  users: { total: number; newLast7d: number }
  credits: {
    balance: number
    ledgerSum: number
    granted: number
    openingBalance: number
    adjustedIn: number
    adjustedOut: number
    generatedCharged: number
    refunded: number
    netSpent: number
    bySource: Array<{ source: string; net: number; inflow: number; outflow: number }>
  }
  generations: { total: number; terminal: number; succeeded: number; successRate: number; topErrors: Array<{ error: string; count: number }> }
  orders: { pending: number; paid: number; amountTotal: number }
  cdks: { unredeemed: number; redeemed: number; revoked: number }
  feedback: { pending: number }
}

export interface AdminFeedbackRow {
  id: number
  userId: string
  content: string
  status: string
  resolvedAt: string | null
  resolvedBy: string | null
  createdAt: string
}

export interface AdminLogRow {
  id: string
  topicId: string
  userId: string
  prompt: string
  finalPrompt: string
  size: string
  requestedCount: number
  status: string
  attempts: number
  error: string | null
  generatedCount: number
  createdAt: string
}

export interface AdminAuditRow {
  id: number
  actorId: string
  action: string
  targetType: string | null
  targetId: string | null
  detail: string | null
  createdAt: string
}

/** 管理后台：一项系统配置。密钥项的 value 恒为 null，只给掩码与「已设置」标记 */
export interface AdminSettingItem {
  key: string
  group: 'generation' | 'payment' | 'mailer' | 'danger' | 'security' | 'data'
  label: string
  kind: 'string' | 'number' | 'boolean' | 'enum' | 'secret' | 'url' | 'money'
  value: string | null
  masked: string | null
  isSet: boolean
  source: 'db' | 'env' | 'unset'
  readOnly: boolean
  danger: boolean
  options: string[] | null
  defaultHint: string | null
  hint: string | null
}

/** 管理后台：某组配置当前能否构造出可用的实现（判据由服务端复用构造器给出） */
export interface AdminConfigHealth {
  group: string
  ready: boolean
  reason: string | null
}

/** 只带上真正有值的查询参数，避免 `?status=` 这类空串污染服务端筛选 */
function toQuery(params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') qs.set(k, String(v))
  }
  const q = qs.toString()
  return q ? `?${q}` : ''
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  })
  const text = await res.text()
  const data = text ? (JSON.parse(text) as T & { error?: string }) : ({} as T & { error?: string })
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error || `请求失败（${res.status}）`)
  return data
}

export const api = {
  sendRegisterCode: (email: string) =>
    call<{ sent: boolean; devCode?: string }>('/api/auth/register/send-code', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),
  register: (input: { name: string; email: string; code: string; password: string; passwordConfirm: string; inviteCode?: string }) =>
    call<{ user: User }>('/api/auth/register', { method: 'POST', body: JSON.stringify(input) }),
  login: (email: string, password: string) =>
    call<{ user: User }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  logout: () => call<{ ok: true }>('/api/auth/logout', { method: 'POST' }),
  me: () => call<{ user: User | null }>('/api/auth/me'),
  listTopics: () => call<{ topics: Topic[] }>('/api/topics'),
  topicDetail: (id: string) => call<TopicDetail>(`/api/topics/${id}`),
  /** 长轮询任务状态变更（since=话题 updatedAt）；返回 changed 与最新 topic */
  watchTopic: async (id: string, since: string, signal?: AbortSignal): Promise<{ changed: boolean; topic: Topic }> => {
    const res = await fetch(`/api/topics/${id}/watch?since=${encodeURIComponent(since)}`, { signal })
    const data = (await res.json()) as { changed: boolean; topic: Topic; error?: string }
    if (!res.ok) throw new ApiError(res.status, data.error || `请求失败（${res.status}）`)
    return data
  },
  renameTopic: (id: string, title: string) =>
    call<{ topic: Topic }>(`/api/topics/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
  deleteTopic: (id: string) => call<{ ok: true }>(`/api/topics/${id}`, { method: 'DELETE' }),
  generate: (input: GenerateImagesInput) =>
    call<GenerateImagesResponse>('/api/generate-images', { method: 'POST', body: JSON.stringify(input) }),
  cancelMessage: (messageId: string) =>
    call<{ ok: true; topic: Topic }>(`/api/messages/${messageId}/cancel`, { method: 'POST' }),
  uploadReference: async (topicId: string, file: File): Promise<{ reference: StagedReference }> => {
    const form = new FormData()
    form.set('topicId', topicId)
    form.set('file', file)
    const res = await fetch('/api/canvas-images', { method: 'POST', body: form })
    const data = (await res.json()) as { reference?: StagedReference; error?: string }
    if (!res.ok) throw new ApiError(res.status, data.error || '上传失败')
    return data as { reference: StagedReference }
  },
  removeStagedReference: (refId: string) =>
    call<{ ok: true }>(`/api/canvas-images?refId=${encodeURIComponent(refId)}`, { method: 'DELETE' }),
  deleteCanvasImage: (id: string) => call<{ ok: true }>(`/api/canvas-images/${id}`, { method: 'DELETE' }),
  deleteCanvasImages: (ids: string[]) =>
    call<{ ok: true; deleted: number }>('/api/canvas-images/delete-batch', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),
  /** 画布快照（含旧库补位）：GET /api/topics/[id]/canvas */
  canvasSnapshot: (topicId: string) => call<CanvasSnapshot>(`/api/topics/${topicId}/canvas`),
  /** 画布增量补丁：返回 applied/rejected/meta（rejected 用于客户端回滚） */
  patchCanvas: (topicId: string, patch: CanvasPatch) =>
    call<{ applied: string[]; rejected: string[]; meta: CanvasMeta }>(`/api/topics/${topicId}/canvas`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  billingPackages: () => call<BillingPackagesResponse>('/api/billing/packages'),
  checkout: (packageId: string) =>
    call<{ orderId: string; checkoutUrl: string }>('/api/billing/checkout', {
      method: 'POST',
      body: JSON.stringify({ packageId }),
    }),
  billingOrderStatus: (orderId: string) =>
    call<{ status: 'pending' | 'paid'; credits?: number }>(`/api/billing/order?order=${encodeURIComponent(orderId)}`),
  mockPay: (orderId: string) =>
    call<{ ok: true; paid: number; user: User }>('/api/billing/mock-pay', {
      method: 'POST',
      body: JSON.stringify({ orderId }),
    }),
  redeem: (code: string) => call<{ user: User }>('/api/redeem', { method: 'POST', body: JSON.stringify({ code }) }),
  feedback: (content: string) => call<{ ok: true }>('/api/feedback', { method: 'POST', body: JSON.stringify({ content }) }),
  adminListCdks: (params: { status?: string; q?: string; page?: number; pageSize?: number } = {}) => {
    const qs = new URLSearchParams()
    if (params.status) qs.set('status', params.status)
    if (params.q) qs.set('q', params.q)
    if (params.page) qs.set('page', String(params.page))
    if (params.pageSize) qs.set('pageSize', String(params.pageSize))
    const q = qs.toString()
    return call<{ items: AdminCdk[]; total: number; page: number; pageSize: number }>(`/api/admin/cdks${q ? `?${q}` : ''}`)
  },
  adminCreateCdks: (input: { count: number; credits: number; prefix?: string }) =>
    call<{ codes: string[]; credits: number }>('/api/admin/cdks', { method: 'POST', body: JSON.stringify(input) }),
  adminRevokeCdk: (code: string) =>
    call<{ ok: true }>('/api/admin/cdks/revoke', { method: 'POST', body: JSON.stringify({ code }) }),
  adminListOrders: (params: { status?: string; userId?: string; page?: number; pageSize?: number } = {}) => {
    const qs = new URLSearchParams()
    if (params.status) qs.set('status', params.status)
    if (params.userId) qs.set('userId', params.userId)
    if (params.page) qs.set('page', String(params.page))
    if (params.pageSize) qs.set('pageSize', String(params.pageSize))
    const q = qs.toString()
    return call<{ items: AdminOrder[]; total: number; page: number; pageSize: number }>(`/api/admin/orders${q ? `?${q}` : ''}`)
  },
  adminOverview: () => call<AdminOverview>('/api/admin/overview'),
  adminListUsers: (params: { q?: string; role?: string; status?: string; page?: number; pageSize?: number } = {}) =>
    call<{ items: User[]; total: number; page: number; pageSize: number }>(`/api/admin/users${toQuery(params)}`),
  adminAdjustCredits: (input: { userId: string; delta: number; reason: string }) =>
    call<{ user: User }>('/api/admin/users/credits', { method: 'POST', body: JSON.stringify(input) }),
  adminSetUserStatus: (userId: string, status: 'active' | 'disabled') =>
    call<{ user: User }>('/api/admin/users/status', { method: 'POST', body: JSON.stringify({ userId, status }) }),
  adminSetUserRole: (userId: string, role: string) =>
    call<{ user: User }>('/api/admin/users/role', { method: 'POST', body: JSON.stringify({ userId, role }) }),
  /** 一次性重置密码：返回的明文只此一次，不要缓存到任何持久化位置 */
  adminResetPassword: (userId: string) =>
    call<{ user: User; password: string }>('/api/admin/users/password', { method: 'POST', body: JSON.stringify({ userId }) }),
  adminListFeedback: (params: { status?: string; page?: number; pageSize?: number } = {}) =>
    call<{ items: AdminFeedbackRow[]; total: number; page: number; pageSize: number }>(`/api/admin/feedback${toQuery(params)}`),
  adminResolveFeedback: (id: number) =>
    call<{ ok: true; feedback: AdminFeedbackRow }>('/api/admin/feedback/resolve', { method: 'POST', body: JSON.stringify({ id }) }),
  adminListLogs: (params: { status?: string; userId?: string; from?: string; to?: string; page?: number; pageSize?: number } = {}) =>
    call<{ items: AdminLogRow[]; total: number; page: number; pageSize: number }>(`/api/admin/logs${toQuery(params)}`),
  adminCleanupLogs: (days: number) =>
    call<{ ok: true; deleted: number; auditDeleted: number; before: string }>('/api/admin/logs/cleanup', { method: 'POST', body: JSON.stringify({ days, confirm: true }) }),
  adminListAudit: (params: { actorId?: string; action?: string; from?: string; to?: string; page?: number; pageSize?: number } = {}) =>
    call<{ items: AdminAuditRow[]; total: number; page: number; pageSize: number }>(`/api/admin/audit${toQuery(params)}`),
  adminGetSettings: () => call<{ items: AdminSettingItem[]; health: AdminConfigHealth[] }>('/api/admin/settings'),
  adminSaveSettings: (updates: Record<string, string>) =>
    call<{ ok: true; updated: string[]; runtimeReloaded: boolean }>('/api/admin/settings', {
      method: 'POST',
      body: JSON.stringify({ updates }),
    }),
  /** 危险区专用入口：确认由服务端强校验（必须严格等于 true），页面上的勾选只是前置流程 */
  adminTestMail: (to: string) =>
    call<{ ok: true; via: string }>('/api/admin/settings/test-mail', { method: 'POST', body: JSON.stringify({ to }) }),
  adminSaveDangerSettings: (updates: Record<string, string>) =>
    call<{ ok: true; updated: string[] }>('/api/admin/settings/danger', {
      method: 'POST',
      body: JSON.stringify({ updates, confirm: true }),
    }),
}
