import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NextRequest } from 'next/server'
import { MotifStore } from '@motif/db'
import { SESSION_COOKIE } from '@/server/auth'
import { GET as cdksGET, POST as cdksPOST } from '@/app/api/admin/cdks/route'
import { POST as revokePOST } from '@/app/api/admin/cdks/revoke/route'
import { POST as redeemPOST } from '@/app/api/redeem/route'

let dir: string
let store: MotifStore

function req(token: string | undefined, body?: unknown): NextRequest {
  return {
    cookies: { get: (n: string) => (n === SESSION_COOKIE && token ? { value: token } : undefined) },
    json: async () => body,
    nextUrl: new URL('http://localhost:3100/api/admin/cdks'),
  } as unknown as NextRequest
}

function sessionFor(role: 'user' | 'admin' | 'root', email: string): string {
  const u = store.createUser({ email, passwordHash: 'h', name: email, role })
  return store.createSession(u.id, 60_000)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'motif-admin-cdk-'))
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
    expect((await cdksGET(req(undefined))).status).toBe(401)
    expect((await cdksGET(req(sessionFor('user', 'u@b.co')))).status).toBe(403)
    expect((await cdksGET(req(sessionFor('admin', 'a@b.co')))).status).toBe(200)
  })
})

describe('POST /api/admin/cdks（批量生成）', () => {
  it('生成 N 个码且面额正确，并写审计', async () => {
    const t = sessionFor('admin', 'a2@b.co')
    const res = await cdksPOST(req(t, { count: 5, credits: 25, prefix: 'WX' }))
    expect(res.status).toBe(201)
    const body = (await res.json()) as { codes: string[]; credits: number }
    expect(body.codes).toHaveLength(5)
    expect(body.credits).toBe(25)
    const rows = store.listCdks({ q: 'WX' })
    expect(rows).toHaveLength(5)
    const audit = store.listAudit({}).filter((r) => r.action === 'cdk.batch_create')
    expect(audit).toHaveLength(1)
    expect(audit[0].detail).toContain('5')
  })

  it('数量越界（0 / 101）被拒且不写入', async () => {
    const t = sessionFor('admin', 'a3@b.co')
    expect((await cdksPOST(req(t, { count: 0, credits: 10 }))).status).toBe(400)
    expect((await cdksPOST(req(t, { count: 101, credits: 10 }))).status).toBe(400)
    expect(store.listCdks({})).toHaveLength(0)
  })

  it('面额非正整数被拒', async () => {
    const t = sessionFor('admin', 'a4@b.co')
    expect((await cdksPOST(req(t, { count: 1, credits: 0 }))).status).toBe(400)
    expect((await cdksPOST(req(t, { count: 1, credits: -5 }))).status).toBe(400)
  })
})

describe('GET /api/admin/cdks（列表）', () => {
  it('支持状态筛选、搜索与分页', async () => {
    const t = sessionFor('admin', 'a5@b.co')
    await cdksPOST(req(t, { count: 6, credits: 10, prefix: 'AAA' }))
    await cdksPOST(req(t, { count: 4, credits: 10, prefix: 'BBB' }))

    const r1 = await cdksGET(req(t))
    const b1 = (await r1.json()) as { items: unknown[]; total: number }
    expect(b1.total).toBe(10)
    expect(b1.items).toHaveLength(10)

    // 真正的分页断言（不是重复调用同一请求）
    const pageReq = {
      cookies: { get: (n: string) => (n === SESSION_COOKIE ? { value: t } : undefined) },
      nextUrl: new URL('http://localhost:3100/api/admin/cdks?page=2&pageSize=6'),
    } as unknown as NextRequest
    const b2 = (await (await cdksGET(pageReq)).json()) as { items: unknown[]; total: number; page: number }
    expect(b2.page).toBe(2)
    expect(b2.total).toBe(10)
    expect(b2.items).toHaveLength(4) // 10 条、每页 6 → 第 2 页剩 4

    // 搜索筛到 4 条
    const searchReq = {
      cookies: { get: (n: string) => (n === SESSION_COOKIE ? { value: t } : undefined) },
      nextUrl: new URL('http://localhost:3100/api/admin/cdks?q=BBB'),
    } as unknown as NextRequest
    const b3 = (await (await cdksGET(searchReq)).json()) as { items: unknown[]; total: number }
    expect(b3.total).toBe(4)
  })
})

describe('批量生成的码可经既有兑换接口真实兑换（跨模块）', () => {
  it('兑换后买方额度精确增加该面额，且不可重复兑换', async () => {
    const t = sessionFor('admin', 'a8@b.co')
    const created = (await (await cdksPOST(req(t, { count: 2, credits: 25 }))).json()) as { codes: string[] }

    // 买方：新建用户默认额度 0，便于断言「精确增加」
    const buyer = store.createUser({ email: 'buyer@b.co', passwordHash: 'h', name: 'buyer' })
    const buyerToken = store.createSession(buyer.id, 60_000)
    expect(store.getUserById(buyer.id)!.credits).toBe(0)

    // 走真实的既有兑换接口（不是 store.redeemCdk），这才覆盖「管理端发码 → 用户端兑换」的完整链路
    const ok = await redeemPOST(req(buyerToken, { code: created.codes[0] }))
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as { user: { credits: number } }).user.credits).toBe(25)
    expect(store.getUserById(buyer.id)!.credits).toBe(25)

    // 同一张码不可重复兑换
    expect((await redeemPOST(req(buyerToken, { code: created.codes[0] }))).status).toBe(400)

    // 【作废与兑换的交叉】另一张作废后同样不可兑换
    expect((await revokePOST(req(t, { code: created.codes[1] }))).status).toBe(200)
    expect((await redeemPOST(req(buyerToken, { code: created.codes[1] }))).status).toBe(400)
    expect(store.getUserById(buyer.id)!.credits).toBe(25) // 额度未因失败兑换而变
  })
})

describe('POST /api/admin/cdks/revoke（作废）', () => {
  it('未兑换码作废成功并写审计；重复作废返回 4xx', async () => {
    const t = sessionFor('admin', 'a6@b.co')
    const created = (await (await cdksPOST(req(t, { count: 2, credits: 5 }))).json()) as { codes: string[] }
    const code = created.codes[0]

    expect((await revokePOST(req(t, { code }))).status).toBe(200)
    expect((await revokePOST(req(t, { code }))).status).toBe(409)

    const audit = store.listAudit({}).filter((r) => r.action === 'cdk.revoke')
    expect(audit).toHaveLength(1)
    expect(audit[0].targetId).toBe(code)
  })

  it('已兑换的码作废返回 4xx，且 revoked_at 保持空', async () => {
    const t = sessionFor('admin', 'a7@b.co')
    const created = (await (await cdksPOST(req(t, { count: 1, credits: 5 }))).json()) as { codes: string[] }
    const user = store.createUser({ email: 'r@b.co', passwordHash: 'h', name: 'r' })
    store.redeemCdk(created.codes[0], user.id)

    expect((await revokePOST(req(t, { code: created.codes[0] }))).status).toBe(409)
    const row = store.listCdks({})[0]
    expect(row.revokedAt).toBeNull()
  })

  it('不存在的码返回 404', async () => {
    const t = sessionFor('root', 'r2@b.co')
    expect((await revokePOST(req(t, { code: 'MOTIF-NOPE' }))).status).toBe(404)
  })

  it('【回归】目标码是另一条更长码的前缀时仍能精确命中，不得误判 404', async () => {
    // 若用 listCdks({ q: code, limit: 1 }).some(...) 判存在性：LIKE %目标% 会同时命中更长的码，
    // 而排序（created_at DESC, code DESC）把更长的码排在前 → LIMIT 1 取回的不是目标 → 误判 404。
    const t = sessionFor('admin', 'a9@b.co')
    store.createCdk('MOTIF-ABC123', 5)
    store.createCdk('MOTIF-ABC12345', 5)
    const res = await revokePOST(req(t, { code: 'MOTIF-ABC123' }))
    expect(res.status).toBe(200)
    expect(store.getCdk('MOTIF-ABC123')!.revokedAt).not.toBeNull()
    // 更长的码不受影响
    expect(store.getCdk('MOTIF-ABC12345')!.revokedAt).toBeNull()
  })
})
