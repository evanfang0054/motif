import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NextRequest } from 'next/server'
import { MotifStore, type AdminLogRow, type FeedbackRow, type UserBrief } from '@motif/db'
import { SESSION_COOKIE } from '@/server/auth'
import { GET as auditGET } from '@/app/api/admin/audit/route'
import { GET as logsGET } from '@/app/api/admin/logs/route'
import { GET as feedbackGET } from '@/app/api/admin/feedback/route'
import { GET as ordersGET } from '@/app/api/admin/orders/route'
import { userBriefMap, userDisplayLabel } from '@/lib/admin-display'

/**
 * 审计 / 生成日志 / 反馈三个列表接口的「人」相关契约（#75-3.1）。
 *
 * 钉住两件在 UI 上才看得见、单测最容易被漏掉的事：
 *  1. 接口**附带**当页引用到的用户摘要（`users`），否则前端只能继续显示裸 `usr_` ID；
 *  2. 筛选词按邮箱 / 昵称 / 裸 ID 三路解析 —— 而且解析不到人时返回 **0 条**，
 *     不能因为「解析出空集」就退化成「不过滤」把全量数据当成筛选结果。
 *
 * 同时用 `userDisplayLabel` 走一遍「接口给的摘要 → 页面显示的文案」，
 * 保证这两段不是各说各话（接口给了但页面没用，等于没修）。
 */

let dir: string
let store: MotifStore

function req(token: string | undefined, path: string, query = ''): NextRequest {
  return {
    cookies: { get: (n: string) => (n === SESSION_COOKIE && token ? { value: token } : undefined) },
    nextUrl: new URL(`http://localhost:3100${path}${query}`),
  } as unknown as NextRequest
}

function sessionFor(role: 'user' | 'admin' | 'root', email: string, name?: string): string {
  const u = store.createUser({ email, passwordHash: 'h', name: name ?? email, role })
  return store.createSession(u.id, 60_000)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'motif-admin-labels-'))
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

describe('GET /api/admin/audit：附带操作者摘要 + 三路筛选', () => {
  it('返回当页操作者的「昵称 + 邮箱」，前端据此渲染成人', async () => {
    const actor = store.createUser({ email: 'ops@b.co', passwordHash: 'h', name: '运维小王', role: 'root' })
    store.insertAudit({ actorId: actor.id, action: 'credit.adjust', targetType: 'user', targetId: 'usr_x' })
    const t = sessionFor('root', 'r@b.co')

    const body = (await (await auditGET(req(t, '/api/admin/audit'))).json()) as { items: unknown[]; users: UserBrief[] }
    expect(body.users).toEqual([{ id: actor.id, name: '运维小王', email: 'ops@b.co' }])

    const map = userBriefMap(body.users)
    const row = (body.items as Array<{ actorId: string }>)[0]
    expect(userDisplayLabel(map.get(row.actorId), row.actorId)).toBe('运维小王（ops@b.co）')
  })

  it('按邮箱筛选能命中该操作者的动作（此前只能贴裸 ID）', async () => {
    const actor = store.createUser({ email: 'ops@b.co', passwordHash: 'h', name: '运维小王', role: 'root' })
    const other = store.createUser({ email: 'other@b.co', passwordHash: 'h', name: '别的超管', role: 'root' })
    store.insertAudit({ actorId: actor.id, action: 'credit.adjust' })
    store.insertAudit({ actorId: other.id, action: 'user.disable' })
    const t = sessionFor('root', 'r2@b.co')

    const byEmail = (await (await auditGET(req(t, '/api/admin/audit', '?actorId=ops@b.co'))).json()) as { items: Array<{ actorId: string }>; total: number }
    expect(byEmail.total).toBe(1)
    expect(byEmail.items[0].actorId).toBe(actor.id)
  })

  it('按昵称筛选能命中；按裸 ID 仍然精确命中', async () => {
    const actor = store.createUser({ email: 'ops@b.co', passwordHash: 'h', name: '运维小王', role: 'root' })
    store.insertAudit({ actorId: actor.id, action: 'credit.adjust' })
    const t = sessionFor('root', 'r3@b.co')

    expect(((await (await auditGET(req(t, '/api/admin/audit', '?actorId=运维小王'))).json()) as { total: number }).total).toBe(1)
    expect(((await (await auditGET(req(t, '/api/admin/audit', `?actorId=${actor.id}`))).json()) as { total: number }).total).toBe(1)
  })

  it('筛选词匹配不到任何人时返回 0 条（不能退化成「不过滤」）', async () => {
    const actor = store.createUser({ email: 'ops@b.co', passwordHash: 'h', name: '运维小王', role: 'root' })
    store.insertAudit({ actorId: actor.id, action: 'credit.adjust' })
    const t = sessionFor('root', 'r4@b.co')

    const body = (await (await auditGET(req(t, '/api/admin/audit', '?actorId=查无此人'))).json()) as { items: unknown[]; total: number; users: UserBrief[] }
    expect(body.total).toBe(0)
    expect(body.items).toHaveLength(0)
    expect(body.users).toEqual([])
  })

  it('不传筛选词时返回全部（回归：解析逻辑不能把「没筛选」也当成空集）', async () => {
    const actor = store.createUser({ email: 'ops@b.co', passwordHash: 'h', name: '运维小王', role: 'root' })
    store.insertAudit({ actorId: actor.id, action: 'credit.adjust' })
    const t = sessionFor('root', 'r5@b.co')
    expect(((await (await auditGET(req(t, '/api/admin/audit'))).json()) as { total: number }).total).toBe(1)
  })
})

describe('GET /api/admin/logs：附带用户摘要 + 三路筛选', () => {
  function seedMessage(userId: string, topicId: string, prompt: string) {
    return store.createMessage({
      topicId,
      userId,
      prompt,
      finalPrompt: prompt,
      size: '1:1',
      requestedCount: 1,
      enhancePrompt: false,
      referenceIds: [],
    })
  }

  it('返回当页用户的摘要，且能按昵称 / 邮箱筛选出该用户的轮次', async () => {
    const u = store.createUser({ email: 'gen@b.co', passwordHash: 'h', name: '出图的人' })
    const other = store.createUser({ email: 'other2@b.co', passwordHash: 'h', name: '另一个人' })
    const t1 = store.createTopic(u.id, 't1')
    const t2 = store.createTopic(other.id, 't2')
    seedMessage(u.id, t1.id, '我要的提示词')
    seedMessage(other.id, t2.id, '别人的提示词')
    const admin = sessionFor('admin', 'a@b.co')

    const all = (await (await logsGET(req(admin, '/api/admin/logs'))).json()) as { items: AdminLogRow[]; users: UserBrief[] }
    expect(all.users.map((x) => x.id).sort()).toEqual([u.id, other.id].sort())
    expect(userDisplayLabel(userBriefMap(all.users).get(u.id), u.id)).toBe('出图的人（gen@b.co）')

    const byName = (await (await logsGET(req(admin, '/api/admin/logs', '?userId=出图的人'))).json()) as { items: AdminLogRow[]; total: number }
    expect(byName.total).toBe(1)
    expect(byName.items[0].prompt).toBe('我要的提示词')

    const byEmail = (await (await logsGET(req(admin, '/api/admin/logs', '?userId=other2@b.co'))).json()) as { total: number }
    expect(byEmail.total).toBe(1)

    const byId = (await (await logsGET(req(admin, '/api/admin/logs', `?userId=${u.id}`))).json()) as { total: number }
    expect(byId.total).toBe(1)
  })

  it('筛选词匹配不到人时返回 0 条', async () => {
    const u = store.createUser({ email: 'gen2@b.co', passwordHash: 'h', name: '出图的人' })
    const t1 = store.createTopic(u.id, 't1')
    seedMessage(u.id, t1.id, 'x')
    const admin = sessionFor('admin', 'a2@b.co')

    const body = (await (await logsGET(req(admin, '/api/admin/logs', '?userId=查无此人'))).json()) as { items: unknown[]; total: number }
    expect(body.total).toBe(0)
    expect(body.items).toHaveLength(0)
  })
})

describe('GET /api/admin/feedback：提交用户与处理人都带摘要', () => {
  it('users 覆盖两列引用的 id（提交用户 + 处理人）', async () => {
    const author = store.createUser({ email: 'author@b.co', passwordHash: 'h', name: '提反馈的人' })
    const handler = store.createUser({ email: 'handler@b.co', passwordHash: 'h', name: '处理的人', role: 'admin' })
    store.insertFeedback(author.id, '这个按钮点不动')
    const row = store.listFeedback({})[0]
    store.resolveFeedback(row.id, handler.id)
    const admin = sessionFor('admin', 'a3@b.co')

    const body = (await (await feedbackGET(req(admin, '/api/admin/feedback'))).json()) as { items: FeedbackRow[]; users: UserBrief[] }
    const map = userBriefMap(body.users)
    expect(map.get(author.id)?.email).toBe('author@b.co')
    expect(map.get(handler.id)?.email).toBe('handler@b.co')

    const item = body.items[0]
    expect(userDisplayLabel(map.get(item.userId), item.userId)).toBe('提反馈的人（author@b.co）')
    expect(userDisplayLabel(map.get(item.resolvedBy ?? ''), item.resolvedBy ?? '')).toBe('处理的人（handler@b.co）')
  })

  it('未处理的反馈没有处理人，users 只含提交用户（不产生空摘要）', async () => {
    const author = store.createUser({ email: 'author2@b.co', passwordHash: 'h', name: '提反馈的人' })
    store.insertFeedback(author.id, '第二条')
    const admin = sessionFor('admin', 'a4@b.co')

    const body = (await (await feedbackGET(req(admin, '/api/admin/feedback'))).json()) as { users: UserBrief[] }
    expect(body.users).toEqual([{ id: author.id, name: '提反馈的人', email: 'author2@b.co' }])
  })
})

describe('GET /api/admin/orders：筛选词同样按人解析', () => {
  const pkg = { id: 'p50', label: '50 张', credits: 50, amountTotal: 6800, currency: 'hkd' }

  it('按邮箱 / 昵称 / 裸 ID 都能筛到该用户的订单（placeholder 承诺的能力必须成立）', async () => {
    const buyer = store.createUser({ email: 'buyer@b.co', passwordHash: 'h', name: '买家甲' })
    const other = store.createUser({ email: 'other3@b.co', passwordHash: 'h', name: '买家乙' })
    store.createOrder(buyer.id, pkg)
    store.createOrder(other.id, pkg)
    store.createOrder(other.id, pkg)
    const admin = sessionFor('admin', 'a5@b.co')

    const all = (await (await ordersGET(req(admin, '/api/admin/orders'))).json()) as { total: number }
    expect(all.total).toBe(3)

    for (const term of ['buyer@b.co', '买家甲', buyer.id]) {
      const body = (await (await ordersGET(req(admin, '/api/admin/orders', `?userId=${encodeURIComponent(term)}`))).json()) as { total: number }
      expect(body.total, `按 ${term} 筛选`).toBe(1)
    }
  })

  it('筛选词匹配不到人时返回 0 条（不退化成「不过滤」）', async () => {
    const buyer = store.createUser({ email: 'buyer2@b.co', passwordHash: 'h', name: '买家丙' })
    store.createOrder(buyer.id, pkg)
    const admin = sessionFor('admin', 'a6@b.co')

    const body = (await (await ordersGET(req(admin, '/api/admin/orders', '?userId=查无此人'))).json()) as { items: unknown[]; total: number }
    expect(body.total).toBe(0)
    expect(body.items).toHaveLength(0)
  })
})
