import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NextRequest } from 'next/server'
import { MotifStore, type FeedbackRow } from '@motif/db'
import { SESSION_COOKIE } from '@/server/auth'
import { GET as feedbackGET } from '@/app/api/admin/feedback/route'
import { POST as resolvePOST } from '@/app/api/admin/feedback/resolve/route'

let dir: string
let store: MotifStore

function req(token: string | undefined, body?: unknown, query = ''): NextRequest {
  return {
    cookies: { get: (n: string) => (n === SESSION_COOKIE && token ? { value: token } : undefined) },
    json: async () => body,
    nextUrl: new URL(`http://localhost:3100/api/admin/feedback${query}`),
  } as unknown as NextRequest
}

function sessionFor(role: 'user' | 'admin' | 'root', email: string): string {
  const u = store.createUser({ email, passwordHash: 'h', name: email, role })
  return store.createSession(u.id, 60_000)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'motif-admin-feedback-'))
  store = new MotifStore(join(dir, 't.db'))
  const g = globalThis as unknown as { __motifRuntime?: { store: MotifStore } }
  g.__motifRuntime = { store } as never
})

afterEach(() => {
  const g = globalThis as unknown as { __motifRuntime?: unknown }
  delete g.__motifRuntime
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('访问控制', () => {
  it('未登录 401 / 普通用户 403 / 管理员 200', async () => {
    expect((await feedbackGET(req(undefined))).status).toBe(401)
    expect((await feedbackGET(req(sessionFor('user', 'u@b.co')))).status).toBe(403)
    expect((await feedbackGET(req(sessionFor('admin', 'a@b.co')))).status).toBe(200)
  })
})

describe('GET /api/admin/feedback', () => {
  it('支持状态筛选与分页', async () => {
    const u = store.createUser({ email: 'fb@b.co', passwordHash: 'h', name: '反馈者' })
    store.insertFeedback(u.id, '一')
    store.insertFeedback(u.id, '二')
    const t = sessionFor('admin', 'a2@b.co')

    const all = (await (await feedbackGET(req(t))).json()) as { items: FeedbackRow[]; total: number }
    expect(all.total).toBe(2)
    expect(all.items[0].content).toBe('二') // 倒序
    expect(all.items[0].status).toBe('pending')

    await resolvePOST(req(t, { id: all.items[0].id }))
    const resolvedReq = {
      cookies: { get: (n: string) => (n === SESSION_COOKIE ? { value: t } : undefined) },
      nextUrl: new URL('http://localhost:3100/api/admin/feedback?status=resolved'),
    } as unknown as NextRequest
    const resolved = (await (await feedbackGET(resolvedReq)).json()) as { total: number; items: FeedbackRow[] }
    expect(resolved.total).toBe(1)
    expect(resolved.items[0].resolvedBy).not.toBeNull()

    const pageReq = {
      cookies: { get: (n: string) => (n === SESSION_COOKIE ? { value: t } : undefined) },
      nextUrl: new URL('http://localhost:3100/api/admin/feedback?page=2&pageSize=1'),
    } as unknown as NextRequest
    const p2 = (await (await feedbackGET(pageReq)).json()) as { items: unknown[]; page: number }
    expect(p2.page).toBe(2)
    expect(p2.items).toHaveLength(1)
  })
})

describe('POST /api/admin/feedback/resolve', () => {
  it('标记成功并写审计：状态、处理时间与处理人齐备', async () => {
    const u = store.createUser({ email: 'fb2@b.co', passwordHash: 'h', name: 'x' })
    store.insertFeedback(u.id, '待处理')
    const t = sessionFor('admin', 'a3@b.co')
    const id = store.listFeedback({})[0].id

    expect((await resolvePOST(req(t, { id }))).status).toBe(200)
    const row = store.getFeedback(id)!
    expect(row.status).toBe('resolved')
    expect(row.resolvedAt).toBeTruthy()
    expect(row.resolvedBy).not.toBeNull()

    const audit = store.listAudit({}).filter((r) => r.action === 'feedback.resolve')
    expect(audit).toHaveLength(1)
    expect(audit[0].targetId).toBe(String(id))
    expect(audit[0].targetType).toBe('feedback')
  })

  it('重复标记返回 409，且首处理人不被覆盖', async () => {
    const u = store.createUser({ email: 'fb3@b.co', passwordHash: 'h', name: 'x' })
    store.insertFeedback(u.id, '待处理')
    const first = sessionFor('admin', 'a4@b.co')
    const id = store.listFeedback({})[0].id
    await resolvePOST(req(first, { id }))
    const firstResolver = store.getFeedback(id)!.resolvedBy

    const other = sessionFor('root', 'r@b.co')
    expect((await resolvePOST(req(other, { id }))).status).toBe(409)
    expect(store.getFeedback(id)!.resolvedBy).toBe(firstResolver)
    expect(store.listAudit({}).filter((r) => r.action === 'feedback.resolve')).toHaveLength(1)
  })

  it('不存在的 id 返回 404；缺 id 或非法 id 返回 400', async () => {
    const t = sessionFor('admin', 'a5@b.co')
    expect((await resolvePOST(req(t, { id: 99999 }))).status).toBe(404)
    expect((await resolvePOST(req(t, {}))).status).toBe(400)
    expect((await resolvePOST(req(t, { id: -1 }))).status).toBe(400)
    expect(store.listAudit({})).toHaveLength(0)
  })
})
