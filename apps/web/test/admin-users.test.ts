import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NextRequest } from 'next/server'
import { MotifStore } from '@motif/db'
import { hashPassword, SESSION_COOKIE } from '@/server/auth'
import { login } from '@/server/services'
import { GET as usersGET } from '@/app/api/admin/users/route'
import { POST as creditsPOST } from '@/app/api/admin/users/credits/route'
import { POST as statusPOST } from '@/app/api/admin/users/status/route'
import { POST as rolePOST } from '@/app/api/admin/users/role/route'
import { POST as passwordPOST } from '@/app/api/admin/users/password/route'

let dir: string
let store: MotifStore

function req(token: string | undefined, body?: unknown): NextRequest {
  return {
    cookies: { get: (n: string) => (n === SESSION_COOKIE && token ? { value: token } : undefined) },
    json: async () => body,
    nextUrl: new URL('http://localhost:3100/api/admin/users'),
  } as unknown as NextRequest
}

function sessionFor(role: 'user' | 'admin' | 'root', email: string): string {
  const u = store.createUser({ email, passwordHash: 'h', name: email, role })
  return store.createSession(u.id, 60_000)
}

const ledgerSum = (): number => (store.db.prepare('SELECT COALESCE(SUM(delta),0) AS s FROM credit_ledger').get() as { s: number }).s
const balance = (): number => (store.db.prepare('SELECT COALESCE(SUM(credits),0) AS s FROM users').get() as { s: number }).s

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'motif-admin-users-'))
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
  it('用户列表：未登录 401 / 普通用户 403 / 管理员 200', async () => {
    expect((await usersGET(req(undefined))).status).toBe(401)
    expect((await usersGET(req(sessionFor('user', 'u@b.co')))).status).toBe(403)
    expect((await usersGET(req(sessionFor('admin', 'a@b.co')))).status).toBe(200)
  })

  it('改角色与重置密码：管理员 403，仅 root 可做', async () => {
    const target = store.createUser({ email: 't@b.co', passwordHash: 'h', name: '目标' })
    const admin = sessionFor('admin', 'a3@b.co')
    expect((await rolePOST(req(admin, { userId: target.id, role: 'admin' }))).status).toBe(403)
    expect((await passwordPOST(req(admin, { userId: target.id }))).status).toBe(403)
    const root = sessionFor('root', 'r@b.co')
    expect((await rolePOST(req(root, { userId: target.id, role: 'admin' }))).status).toBe(200)
    expect(store.getUserById(target.id)!.role).toBe('admin')
  })

  it('用户列表支持搜索与角色/状态筛选', async () => {
    store.createUser({ email: 'findme@b.co', passwordHash: 'h', name: '找我' })
    const banned = store.createUser({ email: 'banned@b.co', passwordHash: 'h', name: '被封' })
    store.setUserStatus(banned.id, 'disabled')
    const t = sessionFor('admin', 'a4@b.co')

    const all = (await (await usersGET(req(t))).json()) as { items: unknown[]; total: number }
    expect(all.total).toBe(3) // findme + banned + 管理员自己
    const searchReq = {
      cookies: { get: (n: string) => (n === SESSION_COOKIE ? { value: t } : undefined) },
      nextUrl: new URL('http://localhost:3100/api/admin/users?q=FINDME'),
    } as unknown as NextRequest
    const found = (await (await usersGET(searchReq)).json()) as { items: Array<{ email: string }>; total: number }
    expect(found.total).toBe(1)
    expect(found.items[0].email).toBe('findme@b.co')
  })
})

describe('额度调整', () => {
  it('正向调整精确生效，写审计且 detail 含原因', async () => {
    const t = sessionFor('admin', 'a5@b.co')
    const u = store.createUser({ email: 'c6@b.co', passwordHash: 'h', name: '补额', credits: 10 })
    const res = await creditsPOST(req(t, { userId: u.id, delta: 25, reason: '渠道补偿' }))
    expect(res.status).toBe(200)
    expect(store.getUserById(u.id)!.credits).toBe(35)
    const audit = store.listAudit({}).filter((r) => r.action === 'credit.adjust')
    expect(audit).toHaveLength(1)
    expect(audit[0].targetId).toBe(u.id)
    expect(audit[0].detail).toContain('渠道补偿')
    expect(audit[0].detail).toContain('25')
    // 流水的 note 也带原因，额度界面能自证
    expect(store.listLedger({ source: 'admin_adjust' })[0].note).toBe('渠道补偿')
  })

  it('负向调整精确生效；余额不足返回 409 且额度不变', async () => {
    const t = sessionFor('admin', 'a6@b.co')
    const u = store.createUser({ email: 'c6b@b.co', passwordHash: 'h', name: '扣额', credits: 10 })
    expect((await creditsPOST(req(t, { userId: u.id, delta: -4, reason: '误发回收' }))).status).toBe(200)
    expect(store.getUserById(u.id)!.credits).toBe(6)
    expect((await creditsPOST(req(t, { userId: u.id, delta: -100, reason: '扣爆' }))).status).toBe(409)
    expect(store.getUserById(u.id)!.credits).toBe(6) // 不做部分扣减
    // 失败那次不得写流水
    expect(store.listLedger({ source: 'admin_adjust' })).toHaveLength(1)
  })

  it('缺原因 / delta 为 0 / 非整数一律 400，且不写审计', async () => {
    const t = sessionFor('admin', 'a7@b.co')
    const u = store.createUser({ email: 'c6c@b.co', passwordHash: 'h', name: 'x', credits: 5 })
    expect((await creditsPOST(req(t, { userId: u.id, delta: 5 }))).status).toBe(400)
    expect((await creditsPOST(req(t, { userId: u.id, delta: 0, reason: '无变化' }))).status).toBe(400)
    expect((await creditsPOST(req(t, { userId: u.id, delta: 1.5, reason: '半张' }))).status).toBe(400)
    expect(store.getUserById(u.id)!.credits).toBe(5)
    expect(store.listAudit({}).filter((r) => r.action === 'credit.adjust')).toHaveLength(0)
  })

  it('不可调整自己的额度；管理员不可调整超管的额度', async () => {
    const admin = store.createUser({ email: 'self@b.co', passwordHash: 'h', name: '管理', role: 'admin' })
    const t = store.createSession(admin.id, 60_000)
    expect((await creditsPOST(req(t, { userId: admin.id, delta: 5, reason: '自己补' }))).status).toBe(403)

    const boss = store.createUser({ email: 'boss2@b.co', passwordHash: 'h', name: '超管', role: 'root' })
    expect((await creditsPOST(req(t, { userId: boss.id, delta: 5, reason: '给超管' }))).status).toBe(403)
  })

  it('调整后账面恒等：余额与账目同步变化且仍然相等', async () => {
    const t = sessionFor('admin', 'a8@b.co')
    const u = store.createUser({ email: 'c7@b.co', passwordHash: 'h', name: 'x', credits: 10 })
    expect(ledgerSum()).toBe(balance()) // 前置：起点就一致
    expect((await creditsPOST(req(t, { userId: u.id, delta: 20, reason: '守恒用例' }))).status).toBe(200)
    expect(balance()).toBe(30)
    expect(ledgerSum()).toBe(30)
    expect(store.countLedger({ source: 'admin_adjust' })).toBe(1)
    expect(store.getUserById(u.id)!.credits).toBe(30)
  })
})

describe('禁用 / 启用', () => {
  it('禁用后既有会话立即失效，且用真实密码也登不进来', async () => {
    const t = sessionFor('admin', 'a9@b.co')
    // ⚠️ 必须用真实 hash：假 hash（如 'h'）会让 verifyPassword 恒为 false，
    // 于是「登录失败」这条断言与 status 校验完全无关 —— 是恒真的假绿
    const u = store.createUser({ email: 'ban@b.co', passwordHash: hashPassword('real-pass-123'), name: '被封' })
    const victim = store.createSession(u.id, 60_000)
    expect(store.getUserBySession(victim)).not.toBeNull()

    // 先证明禁用前这条登录路径本来是通的，否则下面的失败无从归因
    expect(login(store, 'ban@b.co', 'real-pass-123').id).toBe(u.id)

    expect((await statusPOST(req(t, { userId: u.id, status: 'disabled' }))).status).toBe(200)
    expect(store.getUserBySession(victim)).toBeNull()
    // login 是**同步**函数，用 toThrow 而不是 rejects
    expect(() => login(store, 'ban@b.co', 'real-pass-123')).toThrow(/禁用/)
    // 密码不对的人看到的仍是统一文案，不泄露账号是否被禁
    expect(() => login(store, 'ban@b.co', 'wrong-pass')).toThrow(/邮箱或密码不正确/)
  })

  it('禁用不产生任何退额：额度前后完全相等', async () => {
    const t = sessionFor('admin', 'a10@b.co')
    const u = store.createUser({ email: 'ban2@b.co', passwordHash: 'h', name: '被封2', credits: 17 })
    // 造一轮「排队中」的生成，制造「禁用会不会顺手退额」的可观测面
    const tp = store.createTopic(u.id, 't')
    store.createMessage({ topicId: tp.id, userId: u.id, prompt: 'p', finalPrompt: 'f', size: '1:1', requestedCount: 3, enhancePrompt: false, referenceIds: [] })
    expect((await statusPOST(req(t, { userId: u.id, status: 'disabled' }))).status).toBe(200)
    expect(store.getUserById(u.id)!.credits).toBe(17)
    expect(ledgerSum()).toBe(balance())
  })

  it('启用后可以重新登录；启用本身不改额度', async () => {
    const t = sessionFor('admin', 'a11@b.co')
    const u = store.createUser({ email: 'unban@b.co', passwordHash: hashPassword('pw-123456'), name: '解封', credits: 4 })
    await statusPOST(req(t, { userId: u.id, status: 'disabled' }))
    expect(() => login(store, 'unban@b.co', 'pw-123456')).toThrow(/禁用/)
    expect((await statusPOST(req(t, { userId: u.id, status: 'active' }))).status).toBe(200)
    expect(store.getUserById(u.id)!.status).toBe('active')
    expect(store.getUserById(u.id)!.credits).toBe(4)
    expect(login(store, 'unban@b.co', 'pw-123456').id).toBe(u.id) // 解封后能登录
  })

  it('管理员不得禁用超级管理员；最后一个超级管理员不得被禁用', async () => {
    // ⚠️ 不能再造一个 root 来拿会话：注册第 2 个 root 后 countUsersByRole('root') 变成 2，
    // assertNotLastRoot 就不再抛错，接口会返回 200 —— 那条断言根本不可能通过
    const boss = store.createUser({ email: 'boss@b.co', passwordHash: 'h', name: '超管', role: 'root' })
    const rootToken = store.createSession(boss.id, 60_000) // 复用 boss 本身，不新增 root
    const a = sessionFor('admin', 'a12@b.co')

    expect(store.countUsersByRole('root')).toBe(1) // 前置：系统里只有他一个 root
    expect((await statusPOST(req(a, { userId: boss.id, status: 'disabled' }))).status).toBe(403)
    expect((await statusPOST(req(rootToken, { userId: boss.id, status: 'disabled' }))).status).toBe(403)
    expect(store.getUserById(boss.id)!.status).toBe('active')
  })
})

describe('一次性重置密码', () => {
  it('新密码可登录、旧密码失效、must_change_password=1，且审计不含明文', async () => {
    const r = sessionFor('root', 'r3@b.co')
    const u = store.createUser({ email: 'pwd@b.co', passwordHash: hashPassword('old-password-123'), name: '改密' })
    const res = await passwordPOST(req(r, { userId: u.id }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { user: { mustChangePassword: boolean }; password: string }
    expect(body.password).toMatch(/^.{20}$/)
    expect(body.user.mustChangePassword).toBe(true)

    // login 是同步函数：`.resolves` / `.rejects` 对它都不成立
    expect(login(store, 'pwd@b.co', body.password).id).toBe(u.id)
    expect(() => login(store, 'pwd@b.co', 'old-password-123')).toThrow(/邮箱或密码不正确/)

    // 【关键】审计里绝不能出现明文密码
    expect(JSON.stringify(store.listAudit({}))).not.toContain(body.password)
    expect(store.listAudit({}).some((x) => x.action === 'user.reset_password')).toBe(true)
  })

  it('重置密码同时吊销该用户既有会话，且密码不进流水', async () => {
    const r = sessionFor('root', 'r4@b.co')
    const u = store.createUser({ email: 'pwd2@b.co', passwordHash: hashPassword('old-123456'), name: 'x' })
    const victim = store.createSession(u.id, 60_000)
    const res = await passwordPOST(req(r, { userId: u.id }))
    const { password } = (await res.json()) as { password: string }
    expect(store.getUserBySession(victim)).toBeNull()
    expect(JSON.stringify(store.listLedger({})).replace(/"/g, '')).not.toContain(password)
  })
})

describe('审计写入失败的隔离', () => {
  it('审计写入抛错时，主操作仍 200 且额度已落库不回滚', async () => {
    const t = sessionFor('admin', 'a13@b.co')
    const u = store.createUser({ email: 'd5@b.co', passwordHash: 'h', name: 'x', credits: 1 })
    const original = store.insertAudit.bind(store)
    // 让审计写入必然抛错
    store.insertAudit = (() => {
      throw new Error('审计表写入失败（测试注入）')
    }) as typeof store.insertAudit
    try {
      const res = await creditsPOST(req(t, { userId: u.id, delta: 9, reason: '审计失败隔离用例' }))
      expect(res.status).toBe(200) // 主操作不被审计失败拖垮
      // 而且额度**确实已落库**：审计是事后记录，它失败不回滚业务
      expect(store.getUserById(u.id)!.credits).toBe(10)
      expect(ledgerSum()).toBe(balance())
    } finally {
      store.insertAudit = original
    }
    expect(store.listAudit({})).toHaveLength(0) // 审计确实没写成
  })
})
