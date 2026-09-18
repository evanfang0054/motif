'use client'

import type {
  BillingPackagesResponse,
  CanvasImage,
  GenerateImagesInput,
  GenerateImagesResponse,
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
  uploadReference: async (topicId: string, file: File): Promise<{ canvasImage: CanvasImage }> => {
    const form = new FormData()
    form.set('topicId', topicId)
    form.set('file', file)
    const res = await fetch('/api/canvas-images', { method: 'POST', body: form })
    const data = (await res.json()) as { canvasImage?: CanvasImage; error?: string }
    if (!res.ok) throw new ApiError(res.status, data.error || '上传失败')
    return data as { canvasImage: CanvasImage }
  },
  deleteCanvasImage: (id: string) => call<{ ok: true }>(`/api/canvas-images/${id}`, { method: 'DELETE' }),
  deleteCanvasImages: (ids: string[]) =>
    call<{ ok: true; deleted: number }>('/api/canvas-images/delete-batch', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),
  billingPackages: () => call<BillingPackagesResponse>('/api/billing/packages'),
  checkout: (packageId: string) =>
    call<{ orderId: string; checkoutUrl: string }>('/api/billing/checkout', {
      method: 'POST',
      body: JSON.stringify({ packageId }),
    }),
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
}
