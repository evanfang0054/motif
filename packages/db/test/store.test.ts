import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { MotifStore, buildImageKey, storagePathFor } from '../src/index'

let dir: string
let store: MotifStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'motif-db-'))
  store = new MotifStore(join(dir, 'test.db'))
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

function seedUser() {
  return store.createUser({ email: 'a@b.co', passwordHash: 'scrypt$x$y', name: '测试用户', credits: 10 })
}

describe('users & sessions', () => {
  it('创建用户默认字段与注册赠送', () => {
    const u = store.createUser({ email: 'New@B.CO', passwordHash: 'h', name: 'n', credits: 3 })
    expect(u.email).toBe('new@b.co') // 邮箱统一小写
    expect(u.credits).toBe(3)
    expect(u.role).toBe('user')
    expect(u.inviteCode).toMatch(/^[0-9A-Z]{10}$/)
    expect(u.invitedCount).toBe(0)
  })

  it('邮箱唯一', () => {
    seedUser()
    expect(store.getUserByEmail('a@b.co')).not.toBeNull()
    expect(() => store.createUser({ email: 'a@b.co', passwordHash: 'h', name: 'x' })).toThrow()
  })

  it('会话签发与过期删除', () => {
    const u = seedUser()
    const token = store.createSession(u.id, 1000)
    expect(store.getUserBySession(token)?.id).toBe(u.id)
    // 过期后失效：直接构造过期会话验证
    store.db.prepare('UPDATE sessions SET expires_at = ?').run(new Date(Date.now() - 1).toISOString())
    expect(store.getUserBySession(token)).toBeNull()
    store.deleteSession(token)
    expect(store.getUserBySession(token)).toBeNull()
  })

  it('额度原子扣减：不足则失败且余额不变', () => {
    const u = seedUser() // 10
    expect(store.deductCredits(u.id, 4, { source: 'generation_charge' })?.credits).toBe(6)
    expect(store.deductCredits(u.id, 100, { source: 'generation_charge' })).toBeNull()
    expect(store.getUserById(u.id)?.credits).toBe(6)
  })

  it('加额度与邀请计数', () => {
    const u = seedUser()
    store.addCredits(u.id, 5, { source: 'signup_bonus' })
    store.recordInvite(u.id, 3, 'usr_invitee')
    const fresh = store.getUserById(u.id)!
    expect(fresh.credits).toBe(18)
    expect(fresh.invitedCount).toBe(1)
  })
})

describe('verification codes', () => {
  it('发送新码作废旧码；正确码一次性消费', () => {
    const c1 = store.createVerificationCode('register', 'a@b.co', 60000)
    const c2 = store.createVerificationCode('register', 'a@b.co', 60000)
    expect(store.consumeVerificationCode('register', 'a@b.co', c1)).toBe(false) // 旧码作废
    expect(store.consumeVerificationCode('register', 'a@b.co', '000000')).toBe(false)
    expect(store.consumeVerificationCode('register', 'a@b.co', c2)).toBe(true)
    expect(store.consumeVerificationCode('register', 'a@b.co', c2)).toBe(false) // 已用
  })
  it('验证码过期后不可用', () => {
    const c = store.createVerificationCode('register', 'x@y.z', -1)
    expect(store.consumeVerificationCode('register', 'x@y.z', c)).toBe(false)
  })
})

describe('topics & messages & canvas images', () => {
  it('任务创建 / 列表 / 重命名 / 删除', () => {
    const u = seedUser()
    const t = store.createTopic(u.id, '新任务')
    expect(t.status).toBe('idle')
    store.createTopic(u.id, '第二个')
    expect(store.listTopics(u.id)).toHaveLength(2)
    expect(store.renameTopic(t.id, '马克杯套图')?.title).toBe('马克杯套图')
    store.deleteTopic(t.id)
    expect(store.getTopic(t.id)).toBeNull()
  })

  it('生成消息租约与取消退额闭环', () => {
    const u = seedUser()
    const t = store.createTopic(u.id, 'T')
    store.deductCredits(u.id, 8, { source: 'generation_charge' })
    const m = store.createMessage({ topicId: t.id, userId: u.id, prompt: 'p', finalPrompt: 'p', size: '1024x1024', requestedCount: 8, enhancePrompt: false })
    store.setTopicActive(t.id, m.id, 'p', 'pending')
    expect(store.getTopic(t.id)?.status).toBe('pending')

    // worker 认领
    const leased = store.leaseNextMessage('w1', 60000)
    expect(leased?.id).toBe(m.id)
    expect(leased?.status).toBe('running')
    expect(store.leaseNextMessage('w1', 60000)).toBeNull() // 队列空

    // 写入 3 张后取消：退回 5 张
    for (let i = 0; i < 3; i++) {
      store.insertCanvasImage({ topicId: t.id, userId: u.id, messageId: m.id, origin: 'generated', name: `图片 ${i + 1}`, imageKey: `k${i}`, mimeType: 'image/webp', bytes: 10, width: 64, height: 64 })
    }
    expect(store.countGeneratedInMessage(m.id)).toBe(3)
    store.setMessageStatus(m.id, 'canceled')
    store.addCredits(u.id, 8 - 3, { source: 'generation_refund' })
    store.setTopicActive(t.id, null, null, 'idle')

    expect(store.getUserById(u.id)?.credits).toBe(7) // seed 10 → 扣 8 → 退 5 = 7
    expect(store.getTopic(t.id)?.status).toBe('idle')
    expect(store.listCanvasImages(t.id)).toHaveLength(3)
  })

  it('serial 按 topic 递增', () => {
    const u = seedUser()
    const t = store.createTopic(u.id, 'T')
    const a = store.insertCanvasImage({ topicId: t.id, userId: u.id, messageId: null, origin: 'uploaded', name: '参考图', imageKey: 'k', mimeType: 'image/png', bytes: 1, width: 0, height: 0 })
    const b = store.insertCanvasImage({ topicId: t.id, userId: u.id, messageId: null, origin: 'generated', name: '图片 1', imageKey: 'k2', mimeType: 'image/webp', bytes: 1, width: 8, height: 8 })
    expect([a.serial, b.serial]).toEqual([1, 2])
  })

  it('getTopicDetail 返回完整聚合', () => {
    const u = seedUser()
    const t = store.createTopic(u.id, 'T')
    const m = store.createMessage({ topicId: t.id, userId: u.id, prompt: 'p', finalPrompt: 'p', size: 'auto', requestedCount: 1, enhancePrompt: false })
    store.insertCanvasImage({ topicId: t.id, userId: u.id, messageId: m.id, origin: 'generated', name: '图片 1', imageKey: 'k', mimeType: 'image/webp', bytes: 1, width: 8, height: 8 })
    const d = store.getTopicDetail(t.id)!
    expect(d.topic.id).toBe(t.id)
    expect(d.messages).toHaveLength(1)
    expect(d.canvasImages[0].src).toBe(`/api/canvas-images/${d.canvasImages[0].id}`)
    expect(d.messageReferences).toEqual([])
  })
})

describe('cdk / orders / feedback', () => {
  it('CDK 一次性兑换', () => {
    const u = seedUser()
    store.createCdk('test-cdk-10', 10)
    expect(store.redeemCdk('TEST-CDK-10', u.id)).toBe(10)
    expect(store.redeemCdk('TEST-CDK-10', u.id)).toBeNull()
    expect(store.redeemCdk('nope', u.id)).toBeNull()
  })

  it('订单支付幂等', () => {
    const u = seedUser()
    const id = store.createOrder(u.id, { id: 'credits_50', label: '50 张额度', credits: 50, amountTotal: 868, currency: 'hkd' })
    expect(store.payOrder(id, u.id)).toBe(50)
    expect(store.payOrder(id, u.id)).toBeNull()
  })

  it('反馈入库', () => {
    const u = seedUser()
    store.insertFeedback(u.id, '很好用')
    const row = store.db.prepare('SELECT content FROM feedback').get() as { content: string }
    expect(row.content).toBe('很好用')
  })
})

describe('storage helpers', () => {
  it('imageKey 隔离路径 + 文件读写', () => {
    const key = buildImageKey('usr_1', 'top_1', 'msg_1', 'a.webp')
    expect(key).toBe('users/usr_1/topics/top_1/messages/msg_1/generated/a.webp')
    const abs = storagePathFor(dir, key)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, Buffer.from([1, 2, 3]))
    expect(readFileSync(abs).length).toBe(3)
  })
})

describe('findReusableTopic（新任务复用）', () => {
  it('无任何会话返回 null', () => {
    const u = store.createUser({ email: 'ru0@b.co', passwordHash: 'h', name: 'ru0' })
    expect(store.findReusableTopic(u.id)).toBeNull()
  })

  it('存在 idle 0 图会话：返回最近更新的那个', () => {
    const u = store.createUser({ email: 'ru1@b.co', passwordHash: 'h', name: 'ru1' })
    const t1 = store.createTopic(u.id, '旧空会话')
    const t2 = store.createTopic(u.id, '新空会话')
    // 同毫秒创建会令 updated_at 并列（次级 id 排序不确定），回拨 t1 使排序断言确定性
    store.db.prepare('UPDATE topics SET updated_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', t1.id)
    const got = store.findReusableTopic(u.id)
    expect(got?.id).toBe(t2.id)
    expect(got?.id).not.toBe(t1.id)
  })

  it('有图会话（含 uploaded 参考图）与非 idle 会话都不可复用', () => {
    const u = store.createUser({ email: 'ru2@b.co', passwordHash: 'h', name: 'ru2' })
    const withImg = store.createTopic(u.id, '有图会话')
    store.insertCanvasImage({
      topicId: withImg.id, userId: u.id, messageId: null, origin: 'uploaded',
      name: '参考图', imageKey: 'k', mimeType: 'image/png', bytes: 1, width: 0, height: 0,
    })
    const busy = store.createTopic(u.id, '生成中会话')
    store.setTopicActive(busy.id, null, null, 'pending')
    expect(store.findReusableTopic(u.id)).toBeNull()
  })

  it('其他用户的空会话不复用（按用户隔离）', () => {
    const a = store.createUser({ email: 'ru3@b.co', passwordHash: 'h', name: 'ru3' })
    const b = store.createUser({ email: 'ru4@b.co', passwordHash: 'h', name: 'ru4' })
    store.createTopic(a.id, 'a 的空会话')
    expect(store.findReusableTopic(b.id)).toBeNull()
  })
})

describe('deleteCanvasImages（批量删除）', () => {
  it('只删除列出的行，忽略不存在的 id', () => {
    const u = store.createUser({ email: 'bd1@b.co', passwordHash: 'h', name: 'bd1' })
    const t = store.createTopic(u.id, '批量删除')
    const mk = (key: string) =>
      store.insertCanvasImage({
        topicId: t.id, userId: u.id, messageId: null, origin: 'generated',
        name: key, imageKey: key, mimeType: 'image/png', bytes: 1, width: 0, height: 0,
      })
    const a = mk('a'), b = mk('b'), c = mk('c')
    store.deleteCanvasImages([a.id, c.id, 'cimg_missing'])
    expect(store.getCanvasImage(a.id)).toBeNull()
    expect(store.getCanvasImage(c.id)).toBeNull()
    expect(store.getCanvasImage(b.id)?.id).toBe(b.id)
    store.deleteCanvasImages([]) // 空数组不抛错
    expect(store.listCanvasImages(t.id).length).toBe(1)
  })
})

describe('三级角色与用户状态', () => {
  it('新建用户默认 active、不强制改密、角色 user', () => {
    const s = new MotifStore(join(dir, 't.db'))
    const u = s.createUser({ email: 'a@b.co', passwordHash: 'h', name: '甲' })
    expect(u.role).toBe('user')
    expect(u.status).toBe('active')
    expect(u.mustChangePassword).toBe(false)
    s.close()
  })

  it('可创建 root 账号并统计各角色数量', () => {
    const s = new MotifStore(join(dir, 't2.db'))
    s.createUser({ email: 'a@b.co', passwordHash: 'h', name: '甲' })
    const root = s.createUser({ email: 'r@b.co', passwordHash: 'h', name: '超管', role: 'root', mustChangePassword: true })
    expect(root.role).toBe('root')
    expect(root.mustChangePassword).toBe(true)
    expect(s.countUsersByRole('root')).toBe(1)
    expect(s.countUsersByRole('user')).toBe(1)
    expect(s.countUsersByRole('admin')).toBe(0)
    s.close()
  })

  it('改角色与启用状态生效，禁用写入 disabled_at、启用清空', () => {
    const s = new MotifStore(join(dir, 't3.db'))
    const u = s.createUser({ email: 'a@b.co', passwordHash: 'h', name: '甲' })
    s.updateUserRole(u.id, 'admin')
    expect(s.getUserById(u.id)!.role).toBe('admin')

    s.setUserStatus(u.id, 'disabled')
    expect(s.getUserById(u.id)!.status).toBe('disabled')
    // disabled_at 列本身必须被写入（User 类型不暴露该字段，直查数据库）
    const disabledAt = s.db.prepare('SELECT disabled_at FROM users WHERE id = ?').get(u.id) as { disabled_at: string | null }
    expect(disabledAt.disabled_at).not.toBeNull()

    s.setUserStatus(u.id, 'active')
    expect(s.getUserById(u.id)!.status).toBe('active')
    const cleared = s.db.prepare('SELECT disabled_at FROM users WHERE id = ?').get(u.id) as { disabled_at: string | null }
    expect(cleared.disabled_at).toBeNull()
    s.close()
  })

  it('审计表可写入并按操作者查回', () => {
    const s = new MotifStore(join(dir, 't4.db'))
    const u = s.createUser({ email: 'a@b.co', passwordHash: 'h', name: '甲' })
    s.insertAudit({ actorId: u.id, action: 'credit.adjust', targetType: 'user', targetId: u.id, detail: '{"delta":10,"reason":"补偿"}' })
    const rows = s.listAudit({ actorId: u.id })
    expect(rows).toHaveLength(1)
    expect(rows[0].action).toBe('credit.adjust')
    expect(rows[0].detail).toContain('补偿')
    s.close()
  })
})

describe('旧库迁移（真旧 schema → 新 schema）', () => {
  // 手工建「加列之前」的库，并塞入存量行，用于真正执行 7 条 ALTER 迁移路径
  function makeLegacyDb(file: string): void {
    const db = new Database(file)
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
        name TEXT NOT NULL, avatar_url TEXT, role TEXT NOT NULL DEFAULT 'user',
        credits INTEGER NOT NULL DEFAULT 0, invite_code TEXT NOT NULL UNIQUE,
        invited_by TEXT, invited_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE cdks (code TEXT PRIMARY KEY, credits INTEGER NOT NULL, redeemed_by TEXT, redeemed_at TEXT, created_at TEXT NOT NULL);
      CREATE TABLE feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
    `)
    const t = '2026-01-01T00:00:00.000Z'
    db.prepare('INSERT INTO users (id, email, password_hash, name, role, credits, invite_code, invited_count, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run('usr_legacy', 'legacy@b.co', 'scrypt$s$h', '老用户', 'user', 7, 'LEGACYCODE', 0, t, t)
    db.prepare('INSERT INTO cdks (code, credits, created_at) VALUES (?,?,?)').run('OLD-CODE', 5, t)
    db.prepare('INSERT INTO feedback (user_id, content, created_at) VALUES (?,?,?)').run('usr_legacy', '老反馈', t)
    db.close()
  }

  it('在存量旧库上应用迁移：既有行不变、新列取到声明默认值、新表可用', () => {
    const file = join(dir, 'legacy.db')
    makeLegacyDb(file)

    // 构造 store 即触发 applySchema 的 CREATE + 7 条 ALTER
    const s = new MotifStore(file)

    // 既有行不丢、原有字段不变
    const legacy = s.getUserById('usr_legacy')!
    expect(legacy.email).toBe('legacy@b.co')
    expect(legacy.credits).toBe(7)
    expect(legacy.inviteCode).toBe('LEGACYCODE')

    // 新列取到声明默认值
    expect(legacy.status).toBe('active')
    expect(legacy.mustChangePassword).toBe(false)

    const cdk = s.db.prepare('SELECT credits, revoked_at FROM cdks WHERE code = ?').get('OLD-CODE') as { credits: number; revoked_at: string | null }
    expect(cdk.credits).toBe(5)
    expect(cdk.revoked_at).toBeNull()

    const fb = s.db.prepare('SELECT content, status, resolved_at, resolved_by FROM feedback WHERE user_id = ?').get('usr_legacy') as {
      content: string
      status: string
      resolved_at: string | null
      resolved_by: string | null
    }
    expect(fb.content).toBe('老反馈')
    expect(fb.status).toBe('pending')
    expect(fb.resolved_at).toBeNull()
    expect(fb.resolved_by).toBeNull()

    // 新表已建
    s.insertAudit({ actorId: 'usr_legacy', action: 'settings.update' })
    expect(s.listAudit()).toHaveLength(1)

    s.close()
  })

  it('迁移幂等：对同一新库重复构造 store 不抛错且数据不变', () => {
    const file = join(dir, 'twice.db')
    const s1 = new MotifStore(file)
    const u = s1.createUser({ email: 'a@b.co', passwordHash: 'h', name: '甲' })
    s1.close()
    const s2 = new MotifStore(file)
    expect(s2.getUserById(u.id)!.email).toBe('a@b.co')
    expect(s2.getUserById(u.id)!.status).toBe('active')
    s2.close()
  })
})

describe('CDK 批量发放、列表与作废', () => {
  it('批量生成 N 个码：行数与面额正确、码互不重复', () => {
    const s = new MotifStore(join(dir, 'cdk1.db'))
    const codes = s.createCdkBatch({ count: 20, credits: 30 })
    expect(codes).toHaveLength(20)
    expect(new Set(codes).size).toBe(20)
    const rows = s.db.prepare('SELECT code, credits FROM cdks').all() as Array<{ code: string; credits: number }>
    expect(rows).toHaveLength(20)
    expect(rows.every((r) => r.credits === 30)).toBe(true)
    s.close()
  })

  it('码冲突时重试，最终仍得到 count 个可用码', () => {
    const s = new MotifStore(join(dir, 'cdk2.db'))
    // 预置一个必然与生成器「同前缀同长度」的码位：直接占用大量候选不现实，
    // 故用固定生成器注入的方式验证重试逻辑（见实现里的可选 codeFactory）
    let n = 0
    const factory = () => (n++ === 0 ? 'MOTIF-COLLIDE' : `MOTIF-OK${n}`)
    s.createCdk('MOTIF-COLLIDE', 1) // 先占位
    const codes = s.createCdkBatch({ count: 2, credits: 5, codeFactory: factory })
    expect(codes).toHaveLength(2)
    expect(codes).not.toContain('MOTIF-COLLIDE')
    s.close()
  })

  it('批量生成是单事务：中途失败不留下部分写入', () => {
    const s = new MotifStore(join(dir, 'cdk3.db'))
    let n = 0
    // ⚠️ 工厂必须把「重复码」吐够 3 次，否则会被批内重复的跳过分支消化掉而永不失败：
    //   i=0 → 第 1 次调用拿到 MOTIF-DUP，落库成功
    //   i=1 → attempt0 拿到 MOTIF-DUP（批内重复 → 跳过），attempt1 拿到 MOTIF-DUP（仍重复 → 跳过）
    //         → placed 仍为 false → 抛出 → 事务回滚
    const factory = () => (n++ < 3 ? 'MOTIF-DUP' : `MOTIF-X${n}`)

    // 拆成显式 try/catch，避免 toThrow 失败时遮蔽「回滚」这条真正的断言
    let err: unknown = null
    try {
      s.createCdkBatch({ count: 3, credits: 1, codeFactory: factory, maxRetries: 1 })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/冲突/)

    // 这才是「单事务回滚」的证据：第一条曾成功写入，但整批回滚后一行不留
    const cnt = s.db.prepare('SELECT COUNT(*) AS c FROM cdks').get() as { c: number }
    expect(cnt.c).toBe(0)
    s.close()
  })

  it('列表可按状态筛选与搜索', () => {
    const s = new MotifStore(join(dir, 'cdk4.db'))
    s.createCdkBatch({ count: 3, credits: 10, prefix: 'AAA' })
    s.createCdkBatch({ count: 2, credits: 10, prefix: 'BBB' })
    const u = s.createUser({ email: 'c@b.co', passwordHash: 'h', name: 'c' })
    const all = s.listCdks({})
    expect(all).toHaveLength(5)
    // 兑换一个
    s.redeemCdk(all[0].code, u.id)
    expect(s.listCdks({ status: 'redeemed' })).toHaveLength(1)
    expect(s.listCdks({ status: 'unredeemed' })).toHaveLength(4)
    expect(s.listCdks({ q: 'AAA' })).toHaveLength(3)
    expect(s.countCdks({ status: 'unredeemed' })).toBe(4)
    s.close()
  })

  it('作废仅对未兑换的码生效；已兑换的码作废失败且 revoked_at 保持空', () => {
    const s = new MotifStore(join(dir, 'cdk5.db'))
    const [a, b] = s.createCdkBatch({ count: 2, credits: 7 })
    const u = s.createUser({ email: 'd@b.co', passwordHash: 'h', name: 'd' })
    expect(s.redeemCdk(b, u.id)).toBe(7)

    expect(s.revokeCdk(a)).toBe(true)
    const ra = s.db.prepare('SELECT revoked_at FROM cdks WHERE code = ?').get(a) as { revoked_at: string | null }
    expect(ra.revoked_at).not.toBeNull()

    expect(s.revokeCdk(b)).toBe(false)
    const rb = s.db.prepare('SELECT revoked_at FROM cdks WHERE code = ?').get(b) as { revoked_at: string | null }
    expect(rb.revoked_at).toBeNull()

    // 重复作废同一张码返回 false（幂等拒绝）
    expect(s.revokeCdk(a)).toBe(false)
    s.close()
  })

  it('已作废的码不能再被兑换（回归）', () => {
    const s = new MotifStore(join(dir, 'cdk6.db'))
    const [a] = s.createCdkBatch({ count: 1, credits: 9 })
    const u = s.createUser({ email: 'e@b.co', passwordHash: 'h', name: 'e' })
    expect(s.revokeCdk(a)).toBe(true)
    expect(s.redeemCdk(a, u.id)).toBeNull() // ← 修复前这里会返回 9
    const row = s.db.prepare('SELECT redeemed_by FROM cdks WHERE code = ?').get(a) as { redeemed_by: string | null }
    expect(row.redeemed_by).toBeNull()
    s.close()
  })

  it('列表字段包含状态判定所需的 redeemed_by / revoked_at', () => {
    const s = new MotifStore(join(dir, 'cdk7.db'))
    const [a] = s.createCdkBatch({ count: 1, credits: 3 })
    const row = s.listCdks({})[0]
    expect(row.code).toBe(a)
    expect(row.credits).toBe(3)
    expect(row.redeemedBy).toBeNull()
    expect(row.revokedAt).toBeNull()
    expect(row.createdAt).toBeTruthy()
    s.close()
  })
})

describe('额度流水（credit_ledger）', () => {
  it('每次额度变动都留下带来源的流水，且全库账目与余额一致', () => {
    const s = new MotifStore(join(dir, 'led1.db'))
    const u = s.createUser({ email: 'led@b.co', passwordHash: 'h', name: '甲', credits: 5 }) // 建档初始额度 → opening_balance
    s.addCredits(u.id, 3, { source: 'signup_bonus' })
    s.deductCredits(u.id, 2, { source: 'generation_charge', refId: 'msg_x' })
    s.addCredits(u.id, 1, { source: 'generation_refund', refId: 'msg_x' })
    s.addCredits(u.id, 10, { source: 'admin_adjust', refId: 'usr_admin', note: '渠道补偿' })
    s.addCredits(u.id, 20, { source: 'order_paid', refId: 'ord_x' })
    s.addCredits(u.id, 7, { source: 'cdk_redeem', refId: 'MOTIF-XYZ' })

    const rows = s.listLedger({ userId: u.id })
    expect(rows.map((r) => r.source)).toEqual([
      'cdk_redeem', 'order_paid', 'admin_adjust', 'generation_refund', 'generation_charge', 'signup_bonus', 'opening_balance',
    ])
    // 倒序由 id 保证（created_at 可能同毫秒并列，不能拿它断言顺序）
    expect(rows.map((r) => r.id)).toEqual([...rows.map((r) => r.id)].sort((a, b) => b - a))
    expect(rows[0].refId).toBe('MOTIF-XYZ') // 最近一条是 cdk_redeem，带 refId
    expect(rows[rows.length - 1].refId).toBeNull() // 最早一条是建档的 opening_balance，没有 refId

    // 【关键不变式】逐用户与全库都要成立
    const perUser = (s.db.prepare('SELECT COALESCE(SUM(delta),0) AS s FROM credit_ledger WHERE user_id = ?').get(u.id) as { s: number }).s
    expect(perUser).toBe(s.getUserById(u.id)!.credits)
    const allLedger = (s.db.prepare('SELECT COALESCE(SUM(delta),0) AS s FROM credit_ledger').get() as { s: number }).s
    const allUsers = (s.db.prepare('SELECT COALESCE(SUM(credits),0) AS s FROM users').get() as { s: number }).s
    expect(allLedger).toBe(allUsers)

    // 来源可精确归集
    expect(s.countLedger({ source: 'generation_charge' })).toBe(1)
    expect(s.listLedger({ source: 'admin_adjust' })[0].note).toBe('渠道补偿')
    s.close()
  })

  it('扣减余额不足返回 null，且绝不留下「只有流水没有余额变动」的残迹', () => {
    const s = new MotifStore(join(dir, 'led2.db'))
    const u = s.createUser({ email: 'led3@b.co', passwordHash: 'h', name: '丙', credits: 2 })
    expect(s.deductCredits(u.id, 99, { source: 'generation_charge' })).toBeNull()
    expect(s.getUserById(u.id)!.credits).toBe(2)
    expect(s.countLedger({ userId: u.id })).toBe(1) // 只有建档那一条，失败那次没写进去
    s.close()
  })

  it('【迁移】老库（无 credit_ledger 表、有余额）升级后自动补期初结存，且重复构造不重复补', () => {
    const file = join(dir, 'led3.db')
    // ⚠️ 必须用**裸 better-sqlite3 造一个真的不含 credit_ledger 的老库**，
    // 不能用 `DELETE FROM credit_ledger` 模拟 —— 那样表是存在的，恰好会被「表里没有行」这个
    // 错误判据接受，于是实现写错、测试也绿。
    const raw = new Database(file)
    raw.exec(`CREATE TABLE users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, name TEXT NOT NULL,
      avatar_url TEXT, role TEXT NOT NULL DEFAULT 'user', status TEXT NOT NULL DEFAULT 'active',
      must_change_password INTEGER NOT NULL DEFAULT 0, disabled_at TEXT, credits INTEGER NOT NULL DEFAULT 0,
      invite_code TEXT NOT NULL UNIQUE, invited_by TEXT, invited_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`)
    raw
      .prepare("INSERT INTO users (id,email,password_hash,name,credits,invite_code,created_at,updated_at) VALUES ('usr_legacy','legacy@b.co','scrypt$a$b','老用户',42,'LEGACY0001','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')")
      .run()
    expect(raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'credit_ledger'").get()).toBeUndefined()
    raw.close()

    const s2 = new MotifStore(file) // 触发 applySchema
    const rows = s2.listLedger({ userId: 'usr_legacy' })
    expect(rows).toHaveLength(1)
    expect(rows[0].source).toBe('opening_balance')
    expect(rows[0].delta).toBe(42)
    expect((s2.db.prepare('SELECT COALESCE(SUM(delta),0) AS s FROM credit_ledger').get() as { s: number }).s).toBe(42)
    s2.close()

    const s3 = new MotifStore(file)
    expect(s3.listLedger({ userId: 'usr_legacy' })).toHaveLength(1) // 幂等
    s3.close()
  })

  it('【迁移的反向判据】表已存在但为空时不得补期初结存（否则会把账目缺口洗白）', () => {
    const file = join(dir, 'led4.db')
    const s1 = new MotifStore(file)
    const u = s1.createUser({ email: 'led5@b.co', passwordHash: 'h', name: '戊', credits: 0 })
    s1.db.prepare('UPDATE users SET credits = 42 WHERE id = ?').run(u.id) // 手工制造「账目缺口」
    s1.db.prepare('DELETE FROM credit_ledger').run() // 表还在，只是空了
    s1.close()

    const s2 = new MotifStore(file) // 表已存在 → 走「不补」分支
    expect(s2.listLedger({ userId: u.id })).toHaveLength(0) // ← 旧判据（表为空）在这里会补一条，必红
    expect(s2.getUserById(u.id)!.credits).toBe(42) // 余额不动，缺口如实保留（可被巡检发现）
    s2.close()
  })
})
