import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, globSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { MotifStore, buildImageKey, storagePathFor } from '../src/index'
import type { TopicStatus } from '@motif/core'

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

describe('#61 删除任务要交出**全部**待清理的对象 key', () => {
  it('deleteTopic 同时返回画布图与暂存参考图的 key', () => {
    const u = seedUser()
    const t = store.createTopic(u.id, 'T')
    store.insertCanvasImage({
      topicId: t.id,
      userId: u.id,
      messageId: null,
      origin: 'generated',
      name: 'g',
      imageKey: 'users/u/topics/t/messages/m/generated/a.png',
      mimeType: 'image/png',
      bytes: 1,
      width: 8,
      height: 8,
    })
    store.insertReferenceUpload({
      topicId: t.id,
      userId: u.id,
      name: 'r',
      imageKey: 'users/u/topics/t/references/b.png',
      mimeType: 'image/png',
      bytes: 1,
    })
    // 另一任务的对象不该被算进来（否则删 A 会清掉 B 的图）
    const other = store.createTopic(u.id, '别的')
    store.insertReferenceUpload({
      topicId: other.id,
      userId: u.id,
      name: 'x',
      imageKey: 'users/u/topics/other/references/c.png',
      mimeType: 'image/png',
      bytes: 1,
    })

    expect(store.deleteTopic(t.id).sort()).toEqual([
      'users/u/topics/t/messages/m/generated/a.png',
      'users/u/topics/t/references/b.png',
    ])
    expect(store.getTopic(t.id)).toBeNull()
    // 另一任务完好
    expect(store.listReferenceUploads(other.id).length).toBe(1)
  })

  it('⚠️ 反证：只查 canvas_images 会漏掉暂存参考图（这正是 #61 的缺口）', () => {
    const u = seedUser()
    const t = store.createTopic(u.id, 'T')
    store.insertReferenceUpload({
      topicId: t.id,
      userId: u.id,
      name: 'r',
      imageKey: 'users/u/topics/t/references/b.png',
      mimeType: 'image/png',
      bytes: 1,
    })
    const onlyCanvas = store.db.prepare('SELECT image_key FROM canvas_images WHERE topic_id = ?').all(t.id)
    expect(onlyCanvas).toEqual([]) // 旧实现会返回空 → 对象永远留在盘上
    expect(store.deleteTopic(t.id)).toEqual(['users/u/topics/t/references/b.png'])
  })
})

describe('#61 listAllImageKeys 要并上暂存参考图', () => {
  it('两张表都在册对象里；已删任务的对象不在', () => {
    const u = seedUser()
    const t = store.createTopic(u.id, 'T')
    store.insertCanvasImage({
      topicId: t.id,
      userId: u.id,
      messageId: null,
      origin: 'generated',
      name: 'g',
      imageKey: 'k/canvas.png',
      mimeType: 'image/png',
      bytes: 1,
      width: 8,
      height: 8,
    })
    store.insertReferenceUpload({
      topicId: t.id,
      userId: u.id,
      name: 'r',
      imageKey: 'k/staged.png',
      mimeType: 'image/png',
      bytes: 1,
    })
    expect(store.listAllImageKeys().sort()).toEqual(['k/canvas.png', 'k/staged.png'])

    // ⚠️ 关键：暂存参考图在册 → 不会被 storage:migrate --prune-orphans 当孤儿删掉
    const doomed = store.createTopic(u.id, '要删的')
    store.insertReferenceUpload({
      topicId: doomed.id,
      userId: u.id,
      name: 'r2',
      imageKey: 'k/doomed.png',
      mimeType: 'image/png',
      bytes: 1,
    })
    expect(store.listAllImageKeys()).toContain('k/doomed.png')
    store.deleteTopic(doomed.id)
    expect(store.listAllImageKeys()).not.toContain('k/doomed.png')
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
    // ⚠️ 夹具必须是**可达**的进行态：`pending` 在生产里总与一条 queued 消息同时写入。
    // 早先这里写的是 `setTopicActive(busy.id, null, null, 'pending')`（无活跃消息却自称在跑），
    // 而那恰好是本批新增的「读取自愈」要落定的脏状态 —— 用它当夹具，测的是一个不存在的情形。
    const busyMsg = store.createMessage({ topicId: busy.id, userId: u.id, prompt: 'p', finalPrompt: 'p', size: 'auto', requestedCount: 1, enhancePrompt: false })
    store.syncTopicStatus(busy.id, busyMsg.id, 'p', 'queued')
    expect(store.getTopic(busy.id)?.status).toBe('pending')
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
  // 手工建「加列之前」的库，并塞入存量行，用于真正执行 ALTER 迁移路径
  // （新建库的列来自 CREATE TABLE，根本走不到 ALTER —— 覆盖 ALTER 只能靠这张旧库）
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
      -- 旧 topics（尚无 canvas_meta）与旧 messages（尚无 reference_ids / slot_plan）：
      -- 补上它们，applySchema 的 topics.canvas_meta / messages.reference_ids / messages.slot_plan
      -- 三条 ALTER 才会真正执行（否则 CREATE TABLE IF NOT EXISTS 会把新列直接建好，ALTER 全被 catch 吞掉）
      CREATE TABLE topics (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'idle',
        active_message_id TEXT, active_prompt TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, topic_id TEXT NOT NULL, user_id TEXT NOT NULL, prompt TEXT NOT NULL,
        final_prompt TEXT NOT NULL, size TEXT NOT NULL, requested_count INTEGER NOT NULL,
        enhance_prompt INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'queued',
        worker_id TEXT, locked_at TEXT, lease_token TEXT, lease_expires_at TEXT,
        attempts INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL
      );
    `)
    const t = '2026-01-01T00:00:00.000Z'
    db.prepare('INSERT INTO users (id, email, password_hash, name, role, credits, invite_code, invited_count, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run('usr_legacy', 'legacy@b.co', 'scrypt$s$h', '老用户', 'user', 7, 'LEGACYCODE', 0, t, t)
    db.prepare('INSERT INTO cdks (code, credits, created_at) VALUES (?,?,?)').run('OLD-CODE', 5, t)
    db.prepare('INSERT INTO feedback (user_id, content, created_at) VALUES (?,?,?)').run('usr_legacy', '老反馈', t)
    db.prepare('INSERT INTO topics (id, user_id, title, status, created_at, updated_at) VALUES (?,?,?,?,?,?)')
      .run('tp_legacy', 'usr_legacy', '老任务', 'idle', t, t)
    // 不带 reference_ids / slot_plan 的老消息（两列都由 ALTER 补默认值）
    db.prepare('INSERT INTO messages (id, topic_id, user_id, prompt, final_prompt, size, requested_count, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('msg_legacy', 'tp_legacy', 'usr_legacy', '老提示词', '老提示词', '1024x1024', 2, 'completed', t)
    db.close()
  }

  it('在存量旧库上应用迁移：既有行不变、新列取到声明默认值、新表可用', () => {
    const file = join(dir, 'legacy.db')
    makeLegacyDb(file)

    // 构造 store 即触发 applySchema 的 CREATE + 各条 ALTER
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

    // 老消息：messages.slot_plan 由 ALTER 补默认 '[]' → 读回空计划（无骨架，worker 退回现场分配），
    // 且消息本身仍能读出（缺列/解析失败都不会让消息读不出来 —— #88）
    const legacyMsg = s.getMessage('msg_legacy')!
    expect(legacyMsg.slotPlan).toEqual([])
    expect(legacyMsg.referenceIds).toEqual([])
    expect(legacyMsg.status).toBe('completed')

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

describe('概览指标（六组，与等价查询逐项对账）', () => {
  it('六组指标与对同一库的等价查询逐项相等', () => {
    const s = new MotifStore(join(dir, 'ov1.db'))
    const old = s.createUser({ email: 'ov-old@b.co', passwordHash: 'h', name: '老王', credits: 10 })
    const fresh = s.createUser({ email: 'ov-new@b.co', passwordHash: 'h', name: '新人', credits: 5 })
    // 把其中一个用户挪到 30 天前，制造「7 日新增」的差异
    s.db.prepare('UPDATE users SET created_at = ? WHERE id = ?').run('2026-08-01T00:00:00.000Z', old.id)

    const t = s.createTopic(fresh.id, '概览 fixture')
    const mk = (n: number) =>
      s.createMessage({ topicId: t.id, userId: fresh.id, prompt: 'p', finalPrompt: 'f', size: '1:1', requestedCount: n, enhancePrompt: false, referenceIds: [] })
    const m1 = mk(3)
    const m2 = mk(2)
    mk(4) // 保持排队中，用来验证成功率的分母不含非终态
    s.setMessageStatus(m1.id, 'completed')
    s.setMessageStatus(m2.id, 'failed', '网关 502：上游拒绝')

    // 让额度指标有内容：显式制造几笔不同来源的额度变动（流水是额度指标的唯一来源）
    s.addCredits(fresh.id, 3, { source: 'signup_bonus' })
    s.addCredits(fresh.id, 50, { source: 'order_paid', refId: 'ord_fixture' })
    s.addCredits(fresh.id, 20, { source: 'cdk_redeem', refId: 'OV-CDK-1' })
    s.deductCredits(fresh.id, 2, { source: 'generation_charge', refId: m1.id })
    s.addCredits(fresh.id, 1, { source: 'generation_refund', refId: m2.id })

    // 订单：造一张已支付（金额单位是分）
    const oid = s.createOrder(fresh.id, { id: 'credits_50', label: '50 张', credits: 50, amountTotal: 868, currency: 'hkd' })
    s.db.prepare("UPDATE orders SET status='paid', paid_at=? WHERE id=?").run('2026-09-01T00:00:00.000Z', oid)
    // CDK：一张已兑换、一张已作废、一张未兑换
    s.createCdk('ov-cdk-1', 20)
    s.createCdk('ov-cdk-2', 20)
    s.createCdk('ov-cdk-3', 20)
    s.redeemCdk('OV-CDK-1', fresh.id)
    s.revokeCdk('OV-CDK-3')
    s.insertFeedback(fresh.id, '概览用反馈')

    const o = s.overviewStats('2026-09-18T00:00:00.000Z')
    const q = <T>(sql: string, ...p: unknown[]) => s.db.prepare(sql).get(...p) as T
    const qc = (sql: string, ...p: unknown[]) => (s.db.prepare(sql).get(...p) as { c: number }).c

    // 用户
    expect(o.users.total).toBe(qc('SELECT COUNT(*) AS c FROM users'))
    expect(o.users.total).toBe(2)
    expect(o.users.newLast7d).toBe(1) // old 被挪到 8 月，只剩 fresh 落在 7 日窗口内

    // 额度：手算的精确期望值（opening 10+5=15；granted=3+50+20=73，退款不计入发放）
    expect(o.credits.openingBalance).toBe(15)
    expect(o.credits.granted).toBe(73)
    expect(o.credits.adjustedIn).toBe(0)
    expect(o.credits.adjustedOut).toBe(0)
    expect(o.credits.generatedCharged).toBe(2)
    expect(o.credits.refunded).toBe(1)
    expect(o.credits.netSpent).toBe(1)
    expect(o.credits.balance).toBe(87)
    expect(o.credits.ledgerSum).toBe(87)

    // 【闭合恒等式】这些数字必须能自己加回来 —— 它就是概览卡片脚注要展示的式子
    expect(o.credits.balance).toBe(
      o.credits.granted + o.credits.openingBalance + o.credits.adjustedIn + o.credits.refunded - o.credits.adjustedOut - o.credits.generatedCharged
    )

    // bySource 走**另一条代码路径**交叉验证（公开 API + JS 归约），不要再抄一遍 SQL
    const bySourceFromApi = s.listLedger({}).reduce<Record<string, number>>((acc, r) => {
      acc[r.source] = (acc[r.source] ?? 0) + r.delta
      return acc
    }, {})
    expect(Object.fromEntries(o.credits.bySource.map((x) => [x.source, x.net]))).toEqual(bySourceFromApi)
    expect(o.credits.bySource.reduce((a, x) => a + x.net, 0)).toBe(o.credits.balance) // 没有一分钱落在口径外

    // 生成轮次：成功率的分母必须是终态
    expect(o.generations.total).toBe(3)
    expect(o.generations.terminal).toBe(2)
    expect(o.generations.succeeded).toBe(1)
    expect(o.generations.successRate).toBeCloseTo(0.5, 6)
    expect(o.generations.topErrors[0]).toEqual({ error: '网关 502：上游拒绝', count: 1 })

    // 订单 / CDK / 反馈
    expect(o.orders.total).toBe(1)
    expect(o.orders.paid).toBe(1)
    expect(o.orders.pending).toBe(0)
    // 金额按币种分组：跨币种求和会得出没有意义的数，所以结构是数组而不是单个数字
    expect(o.orders.amountByCurrency).toEqual([{ currency: 'hkd', amountTotal: 868 }])
    expect(o.cdks.unredeemed).toBe(1)
    expect(o.cdks.redeemed).toBe(1)
    expect(o.cdks.revoked).toBe(1)
    expect(o.feedback.pending).toBe(1)
    s.close()
  })

  it('概览订单金额按币种分组，不跨币种求和', () => {
    const s = new MotifStore(join(dir, 'ov-cur.db'))
    const u = s.createUser({ email: 'ovcur@b.co', passwordHash: 'h', name: 'x' })
    const mkPaid = (id: string, amountTotal: number, currency: string) => {
      const oid = s.createOrder(u.id, { id, label: id, credits: 10, amountTotal, currency })
      s.payOrder(oid, u.id)
    }
    mkPaid('credits_50', 868, 'hkd')
    mkPaid('credits_100', 6800, 'cny')
    mkPaid('credits_200', 200, 'hkd')

    const o = s.overviewStats()
    // 两条 hkd 合并成一组，cny 单独一组；按金额降序（cny 6800 > hkd 1068）
    expect(o.orders.amountByCurrency).toEqual([
      { currency: 'cny', amountTotal: 6800 },
      { currency: 'hkd', amountTotal: 1068 },
    ])
    // 关键断言：跨币种求和会得到 7868 这个没有意义的数 —— 它不该出现在任何字段里
    expect(JSON.stringify(o.orders)).not.toContain('7868')
    s.close()
  })

  it('成功率分母不含排队中与生成中', () => {
    const s = new MotifStore(join(dir, 'ov2.db'))
    const u = s.createUser({ email: 'ov2@b.co', passwordHash: 'h', name: 'x' })
    const t = s.createTopic(u.id, 't')
    const mk = () => s.createMessage({ topicId: t.id, userId: u.id, prompt: 'p', finalPrompt: 'f', size: '1:1', requestedCount: 1, enhancePrompt: false, referenceIds: [] })
    const a = mk()
    const b = mk()
    mk()
    mk()
    s.setMessageStatus(a.id, 'completed')
    s.setMessageStatus(b.id, 'failed', 'e')
    const o = s.overviewStats()
    expect(o.generations.total).toBe(4)
    expect(o.generations.terminal).toBe(2)
    expect(o.generations.successRate).toBeCloseTo(0.5, 6) // 若把非终态算进分母会变成 0.25 → 必红
    s.close()
  })

  it('空库不抛错，比率与取负项都不得产出 NaN 或 -0', () => {
    const s = new MotifStore(join(dir, 'ov3.db'))
    const o = s.overviewStats()
    expect(o.users.total).toBe(0)
    expect(o.generations.terminal).toBe(0)
    expect(o.generations.successRate).toBe(0)
    expect(o.credits.granted).toBe(0)
    // 这三条专守 `-sumLedger(...)` 的 -0 陷阱（vitest 的 toBe 用 Object.is，-0 与 0 不等）
    expect(o.credits.generatedCharged).toBe(0)
    expect(o.credits.netSpent).toBe(0)
    expect(o.credits.adjustedOut).toBe(0)
    expect(o.credits.ledgerSum).toBe(0)
    s.close()
  })
})

describe('用户列表（管理端）', () => {
  it('按关键词搜索邮箱与昵称，按角色/状态筛选，分页生效', () => {
    const s = new MotifStore(join(dir, 'usr1.db'))
    s.createUser({ email: 'alice@b.co', passwordHash: 'h', name: '爱丽丝' })
    s.createUser({ email: 'bob@b.co', passwordHash: 'h', name: '鲍勃' })
    const disabled = s.createUser({ email: 'carol@b.co', passwordHash: 'h', name: '卡罗尔' })
    s.setUserStatus(disabled.id, 'disabled')
    const root = s.createUser({ email: 'root@b.co', passwordHash: 'h', name: '超管', role: 'root' })

    expect(s.countUsers({})).toBe(4)
    expect(s.listUsers({ limit: 2, offset: 0 })).toHaveLength(2)
    expect(s.listUsers({ limit: 2, offset: 2 })).toHaveLength(2)
    expect(s.listUsers({ q: 'alice' })).toHaveLength(1) // 邮箱命中
    expect(s.listUsers({ q: 'ALICE' })).toHaveLength(1) // 大小写不敏感（邮箱统一小写存储）
    expect(s.listUsers({ q: '鲍勃' })).toHaveLength(1) // 昵称命中
    expect(s.listUsers({ role: 'root' })).toHaveLength(1)
    expect(s.listUsers({ status: 'disabled' })).toHaveLength(1)
    expect(s.countUsers({ status: 'disabled' })).toBe(1)
    // 返回的是完整 User（复用同一条行映射），不是裸行
    const one = s.listUsers({ q: 'carol' })[0]
    expect(one.status).toBe('disabled')
    expect(one.mustChangePassword).toBe(false)
    expect(s.listUsers({ q: root.email })[0].role).toBe('root')
    s.close()
  })
})

describe('反馈处理', () => {
  it('列表可按状态筛选与分页；标记后 status/resolved_at/resolved_by 齐备；重复标记幂等拒绝', () => {
    const s = new MotifStore(join(dir, 'fb1.db'))
    const u = s.createUser({ email: 'fb@b.co', passwordHash: 'h', name: '反馈者' })
    const admin = s.createUser({ email: 'fbadmin@b.co', passwordHash: 'h', name: '处理人', role: 'admin' })
    s.insertFeedback(u.id, '第一条')
    s.insertFeedback(u.id, '第二条')
    s.insertFeedback(u.id, '第三条')

    expect(s.countFeedback({ status: 'pending' })).toBe(3)
    expect(s.listFeedback({ limit: 2 })).toHaveLength(2)
    expect(s.listFeedback({ limit: 2, offset: 2 })).toHaveLength(1)

    const first = s.listFeedback({})[0] // 倒序：最后插入的在前
    expect(first.content).toBe('第三条')
    expect(first.resolvedBy).toBeNull()
    expect(s.resolveFeedback(first.id, admin.id)).toBe(true)

    const row = s.db.prepare('SELECT status, resolved_at, resolved_by FROM feedback WHERE id = ?').get(first.id) as {
      status: string
      resolved_at: string | null
      resolved_by: string | null
    }
    expect(row.status).toBe('resolved')
    expect(row.resolved_at).toBeTruthy()
    expect(row.resolved_by).toBe(admin.id)

    expect(s.countFeedback({ status: 'pending' })).toBe(2)
    expect(s.countFeedback({ status: 'resolved' })).toBe(1)
    expect(s.listFeedback({ status: 'resolved' })[0].id).toBe(first.id)

    // 重复标记返回 false（条件 UPDATE 未命中），且不覆盖首个处理人
    expect(s.resolveFeedback(first.id, admin.id)).toBe(false)
    expect((s.db.prepare('SELECT resolved_by FROM feedback WHERE id = ?').get(first.id) as { resolved_by: string }).resolved_by).toBe(admin.id)
    expect(s.resolveFeedback(99999, admin.id)).toBe(false)
    s.close()
  })
})

describe('生成日志（跨用户）与清理', () => {
  it('跨用户返回、含 prompt/finalPrompt 原文、倒序且分页生效', () => {
    const s = new MotifStore(join(dir, 'log1.db'))
    const u1 = s.createUser({ email: 'l1@b.co', passwordHash: 'h', name: '甲' })
    const u2 = s.createUser({ email: 'l2@b.co', passwordHash: 'h', name: '乙' })
    const t1 = s.createTopic(u1.id, 't1')
    const t2 = s.createTopic(u2.id, 't2')
    s.createMessage({ topicId: t1.id, userId: u1.id, prompt: '甲的提示词', finalPrompt: '甲增强后', size: '1:1', requestedCount: 1, enhancePrompt: true, referenceIds: [] })
    s.createMessage({ topicId: t2.id, userId: u2.id, prompt: '乙的提示词', finalPrompt: '乙增强后', size: '1:1', requestedCount: 1, enhancePrompt: true, referenceIds: [] })
    const third = s.createMessage({ topicId: t1.id, userId: u1.id, prompt: '第三轮', finalPrompt: '第三增强', size: '1:1', requestedCount: 1, enhancePrompt: true, referenceIds: [] })
    s.setMessageStatus(third.id, 'failed', '网关 502')

    const all = s.listAllMessages({})
    expect(all).toHaveLength(3)
    expect(new Set(all.map((r) => r.userId)).size).toBe(2) // 确实是跨用户
    expect(all[0].prompt).toBe('第三轮') // 倒序
    expect(all[0].finalPrompt).toBe('第三增强')
    expect(all[0].error).toBe('网关 502')
    expect(all[0].status).toBe('failed')

    expect(s.listAllMessages({ userId: u2.id })).toHaveLength(1)
    expect(s.listAllMessages({ status: 'failed' })).toHaveLength(1)
    expect(s.listAllMessages({ limit: 2 })).toHaveLength(2)
    expect(s.listAllMessages({ limit: 2, offset: 2 })).toHaveLength(1)
    expect(s.countAllMessages({ userId: u1.id })).toBe(2)
    expect(s.countAllMessages({})).toBe(3)
    s.close()
  })

  it('清理只删终态且超期，不删画布资产、不动额度与流水，且幂等', () => {
    const s = new MotifStore(join(dir, 'log2.db'))
    const u = s.createUser({ email: 'l3@b.co', passwordHash: 'h', name: '丙', credits: 40 })
    const t = s.createTopic(u.id, 't')
    const mk = (rc: number) =>
      s.createMessage({ topicId: t.id, userId: u.id, prompt: 'p', finalPrompt: 'f', size: '1:1', requestedCount: rc, enhancePrompt: false, referenceIds: [] })
    const oldDone = mk(2)
    const oldFailed = mk(3)
    const oldQueued = mk(2) // 非终态 + 超期 → 不能删（未结清账目）
    const freshDone = mk(1)
    s.setMessageStatus(oldDone.id, 'completed')
    s.setMessageStatus(oldFailed.id, 'failed', 'e')
    s.setMessageStatus(freshDone.id, 'completed')
    s.db.prepare("UPDATE messages SET created_at = '2026-01-01T00:00:00.000Z' WHERE id IN (?, ?, ?)").run(oldDone.id, oldFailed.id, oldQueued.id)
    s.insertCanvasImage({ topicId: t.id, userId: u.id, messageId: oldDone.id, origin: 'generated', name: 'a.png', imageKey: 'k/a.png', mimeType: 'image/png', bytes: 1, width: 1, height: 1 })
    s.insertCanvasImage({ topicId: t.id, userId: u.id, messageId: oldFailed.id, origin: 'generated', name: 'b.png', imageKey: 'k/b.png', mimeType: 'image/png', bytes: 1, width: 1, height: 1 })

    const before = {
      credits: s.getUserById(u.id)!.credits,
      images: (s.db.prepare('SELECT COUNT(*) AS c FROM canvas_images').get() as { c: number }).c,
      ledgerRows: (s.db.prepare('SELECT COUNT(*) AS c FROM credit_ledger').get() as { c: number }).c,
      ledgerSum: (s.db.prepare('SELECT COALESCE(SUM(delta),0) AS s FROM credit_ledger').get() as { s: number }).s,
    }

    expect(s.cleanupMessagesBefore('2026-06-01T00:00:00.000Z')).toBe(2)

    const left = s.listAllMessages({})
    expect(left.map((r) => r.id).sort()).toEqual([oldQueued.id, freshDone.id].sort())
    // 【守恒的实质】清理只删日志：余额、画布资产、以及流水都必须一动不动
    expect(s.getUserById(u.id)!.credits).toBe(before.credits)
    expect((s.db.prepare('SELECT COUNT(*) AS c FROM canvas_images').get() as { c: number }).c).toBe(before.images)
    expect((s.db.prepare('SELECT COUNT(*) AS c FROM credit_ledger').get() as { c: number }).c).toBe(before.ledgerRows)
    expect((s.db.prepare('SELECT COALESCE(SUM(delta),0) AS s FROM credit_ledger').get() as { s: number }).s).toBe(before.ledgerSum)
    // 存活的两轮各自精确对得上
    const queued = left.find((r) => r.id === oldQueued.id)!
    expect(queued.status).toBe('queued')
    expect(queued.requestedCount).toBe(2)
    expect(queued.generatedCount).toBe(0)
    const done = left.find((r) => r.id === freshDone.id)!
    expect(done.status).toBe('completed')
    expect(done.requestedCount).toBe(1)
    // 幂等：再清一次没有可删的
    expect(s.cleanupMessagesBefore('2026-06-01T00:00:00.000Z')).toBe(0)
    s.close()
  })
})

// ---------- 批 2：状态派生收口 + 终态守卫 + 读取自愈（#81 / #86）----------

describe('话题状态派生与读取自愈', () => {
  /** 建一条「已入队」的消息并把话题同步为 pending —— 生产里这两个写入是同一步 */
  function enqueue(u: { id: string }, t: { id: string }, count = 2) {
    store.deductCredits(u.id, count, { source: 'generation_charge' })
    const m = store.createMessage({
      topicId: t.id, userId: u.id, prompt: 'p', finalPrompt: 'p',
      size: 'auto', requestedCount: count, enhancePrompt: false,
    })
    store.syncTopicStatus(t.id, m.id, 'p', 'queued')
    return m
  }

  it('worker 认领消息后话题变「生成中」（#86）', () => {
    const u = seedUser()
    const t = store.createTopic(u.id, 'T')
    const m = enqueue(u, t)
    expect(store.getTopic(t.id)?.status).toBe('pending')

    expect(store.leaseNextMessage('w1', 60000)?.id).toBe(m.id)
    // 认领后话题必须是 running —— 否则 UI 的「生成中」文案永远不出现
    expect(store.getTopic(t.id)?.status).toBe('running')
    expect(store.getTopic(t.id)?.activeMessageId).toBe(m.id)
  })

  it('syncTopicStatus 一律由消息状态派生（含终态回 idle）', () => {
    const u = seedUser()
    const t = store.createTopic(u.id, 'T')
    const m = enqueue(u, t)

    store.syncTopicStatus(t.id, m.id, 'p', 'running')
    expect(store.getTopic(t.id)?.status).toBe('running')
    store.syncTopicStatus(t.id, m.id, 'p', 'canceling')
    expect(store.getTopic(t.id)?.status).toBe('canceling')
    // 终态三态都回 idle，且清空活跃消息
    for (const s of ['completed', 'failed', 'canceled'] as const) {
      store.syncTopicStatus(t.id, m.id, 'p', s)
      const got = store.getTopic(t.id)!
      expect(got.status).toBe('idle')
      expect(got.activeMessageId).toBeNull()
    }
  })

  it('读取自愈：卡在 canceling、活跃消息已失败的脏状态（#81 的卡死形态）', () => {
    const u = seedUser()
    const t = store.createTopic(u.id, 'T')
    const m = enqueue(u, t)
    store.leaseNextMessage('w1', 60000)
    // 造出 #81 的现场：消息落 failed，话题仍停在 canceling 且还挂着那条消息
    store.setMessageStatus(m.id, 'failed', '网关 503')
    store.setTopicActive(t.id, m.id, 'p', 'canceling')
    expect(store.db.prepare('SELECT status FROM topics WHERE id = ?').get(t.id)).toEqual({ status: 'canceling' })

    const got = store.getTopic(t.id)!
    expect(got.status).toBe('idle')
    expect(got.activeMessageId).toBeNull()
    expect(got.activePrompt).toBeNull()
  })

  it('读取自愈：pending 但活跃消息已完成', () => {
    const u = seedUser()
    const t = store.createTopic(u.id, 'T')
    const m = enqueue(u, t)
    store.leaseNextMessage('w1', 60000)
    store.setMessageStatus(m.id, 'completed')
    store.setTopicActive(t.id, m.id, 'p', 'pending')

    expect(store.getTopic(t.id)?.status).toBe('idle')
  })

  it('读取自愈会 bump updatedAt（长轮询据此立刻发现自愈）', () => {
    const u = seedUser()
    const t = store.createTopic(u.id, 'T')
    const m = enqueue(u, t)
    store.setMessageStatus(m.id, 'failed')
    store.setTopicActive(t.id, m.id, 'p', 'canceling')
    const before = store.getTopic(t.id)!.updatedAt

    // 第一次读触发自愈并 bump
    store.getTopic(t.id)
    const afterFirst = store.db.prepare('SELECT updated_at FROM topics WHERE id = ?').get(t.id) as { updated_at: string }
    expect(afterFirst.updated_at >= before).toBe(true)
    // 已落定后再读不再改（不会把长轮询变成无限变更流）
    const beforeSecond = afterFirst.updated_at
    store.getTopic(t.id)
    expect((store.db.prepare('SELECT updated_at FROM topics WHERE id = ?').get(t.id) as { updated_at: string }).updated_at).toBe(beforeSecond)
  })

  it('读取自愈**不得**误伤真正在跑的任务', () => {
    const u = seedUser()
    const cases: Array<{ name: string; msgStatus: 'queued' | 'running' | 'canceling'; topicStatus: TopicStatus }> = [
      { name: 'pending + 活跃 queued', msgStatus: 'queued', topicStatus: 'pending' },
      { name: 'running + 活跃 running', msgStatus: 'running', topicStatus: 'running' },
      { name: 'canceling + 活跃 canceling', msgStatus: 'canceling', topicStatus: 'canceling' },
    ]
    for (const c of cases) {
      const t = store.createTopic(u.id, c.name)
      const m = enqueue(u, t)
      store.setMessageStatus(m.id, c.msgStatus)
      store.setTopicActive(t.id, m.id, 'p', c.topicStatus)
      const got = store.getTopic(t.id)!
      expect(got.status, c.name).toBe(c.topicStatus)
      expect(got.activeMessageId, c.name).toBe(m.id)
    }
  })

  it('listTopics 也会批量自愈，且不误伤在跑的任务', () => {
    const u = seedUser()
    const stale = store.createTopic(u.id, '脏的')
    const sm = enqueue(u, stale)
    store.setMessageStatus(sm.id, 'failed')
    store.setTopicActive(stale.id, sm.id, 'p', 'canceling')

    const live = store.createTopic(u.id, '在跑的')
    const lm = enqueue(u, live)

    const listed = store.listTopics(u.id)
    expect(listed.find((x) => x.id === stale.id)?.status).toBe('idle')
    expect(listed.find((x) => x.id === live.id)?.status).toBe('pending')
    expect(store.getTopic(live.id)?.activeMessageId).toBe(lm.id)
  })

  it('排队中取消：话题回 idle、全额退额，且不产生多余流水', () => {
    const u = seedUser()
    const t = store.createTopic(u.id, 'T')
    const m = enqueue(u, t, 3)
    expect(store.getUserById(u.id)?.credits).toBe(7) // seed 10 → 扣 3

    const res = store.cancelQueuedMessage(m.id, u.id)
    expect(res).toEqual({ found: true, canceled: true, refund: 3 })
    expect(store.getUserById(u.id)?.credits).toBe(10)
    expect(store.getTopic(t.id)?.status).toBe('idle')
    expect(store.getTopic(t.id)?.activeMessageId).toBeNull()
    // 额度守恒：流水求和 === 余额
    const ov = store.overviewStats()
    expect(ov.credits.ledgerSum).toBe(ov.credits.balance)
  })

  it('额度守恒：终态守卫路径不产生任何流水（对终态消息取消）', () => {
    const u = seedUser()
    const t = store.createTopic(u.id, 'T')
    const m = enqueue(u, t, 2)
    store.leaseNextMessage('w1', 60000)
    store.setMessageStatus(m.id, 'failed', '网关 503')
    store.syncTopicStatus(t.id, null, null, 'failed')

    const before = {
      credits: store.getUserById(u.id)!.credits,
      rows: (store.db.prepare('SELECT COUNT(*) AS c FROM credit_ledger').get() as { c: number }).c,
    }
    // 对已失败的轮次再取消：消息非 queued，故 cancelQueuedMessage 不改任何东西
    const res = store.cancelQueuedMessage(m.id, u.id)
    expect(res).toEqual({ found: true, canceled: false, refund: 0 })
    expect(store.getUserById(u.id)!.credits).toBe(before.credits)
    expect((store.db.prepare('SELECT COUNT(*) AS c FROM credit_ledger').get() as { c: number }).c).toBe(before.rows)
    expect(store.getTopic(t.id)?.status).toBe('idle') // 未被取消动作改坏
    const ov = store.overviewStats()
    expect(ov.credits.ledgerSum).toBe(ov.credits.balance)
  })

  it('findReusableTopic 也走自愈（否则会出现「列表说空闲、却复用不到」）', () => {
    const u = seedUser()
    const t = store.createTopic(u.id, '脏的空会话')
    const m = enqueue(u, t)
    store.setMessageStatus(m.id, 'failed')
    store.setTopicActive(t.id, m.id, 'p', 'canceling')

    expect(store.findReusableTopic(u.id)?.id).toBe(t.id)
  })

  it('全仓源码里没有绕过 syncTopicStatus 的 topic 状态直写', () => {
    // 这条是「收口」的机械断言。⚠️ 必须扫**全仓** src 而不是只扫 store.ts：
    // `setTopicActive` 是 public 的，而 #81/#86 的原缺陷恰恰发生在 apps/web 侧的调用点。
    const root = fileURLToPath(new URL('../../..', import.meta.url))
    const srcFiles = [
      ...globSync('packages/*/src/**/*.ts', { cwd: root }),
      ...globSync('apps/web/src/**/*.ts', { cwd: root }),
      ...globSync('apps/web/src/**/*.tsx', { cwd: root }),
    ]
    expect(srcFiles.length).toBeGreaterThan(50) // 防止 glob 写错导致「零文件通过」

    const STORE = 'packages/db/src/store.ts'
    const offenders: string[] = []
    for (const rel of srcFiles) {
      const text = readFileSync(join(root, rel), 'utf8')
      // 1) 除 store.ts 外，任何地方都不许调 setTopicActive
      if (rel !== STORE && text.includes('setTopicActive(')) offenders.push(`${rel}: setTopicActive`)
      // 2) 除 store.ts 外（存储层是唯一允许写 topics.status 的地方 —— `syncTopicStatus` 与
      //    `settleStaleTopic` 都在其中，且都用绑定参数），任何地方都不许裸写 topics 的 status。
      //    判据覆盖**两种形态**：字面量 `= '...'` 与绑定参数 `= ?` —— 只抓字面量的话，
      //    `UPDATE topics SET status = ?` 这类写法会漏网，断言就与「写入必须落在 store.ts」不等价。
      if (rel !== STORE && /UPDATE\s+topics\s+SET[^`]*status\s*=\s*['?]/i.test(text)) {
        offenders.push(`${rel}: 裸写 topics.status`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('全仓源码里没有绕过 CAS 收尾的 messages.status 直写（计费路径的收口断言）', () => {
    // 与上一条同款，对象换成 `messages.status`。判据（比「白名单方法名」更严、且不会随方法增删
    // 悄悄变宽）：`messages.status` 的**任何**写入都必须落在 `packages/db/src/store.ts` 内 ——
    //   ① 裸 SQL 字面量（`UPDATE messages SET ... status = '...'`）：会绕过 CAS 守卫与流水；
    //   ①' 绑定参数形态（`UPDATE messages SET ... status = ?`）：同样绕过 CAS 守卫与流水，且旧正则
    //      要求 `=` 后紧跟 `'`，这类写法根本不会被抓 —— 故字符类写成 `['?]`，两种形态一起覆盖；
    //   ② 公开的无条件写入器 `setMessageStatus(`：它无条件写 + 清 worker_id/lease，正是本批
    //      在 `executeMessage` 成功分支上修掉的那个缺陷的载体（当时它在 apps/web 侧被直接调用）。
    // store.ts 内部的写入方法（finalizeCancel / finalizeFailure / finalizeSuccess / leaseNextMessage /
    // requeueExpiredLeases / cancelQueuedMessage / markMessageCanceling / setMessageStatus）各自的
    // 原子性与守卫由本文件的 #93 系列用例钉住。
    // 为什么不做「方法名白名单」：白名单只约束「调了哪个方法」，挡不住「在 apps/web 里调 setMessageStatus」
    // 或「内联一段裸 SQL」这两种形态；把写入点整体收进 store.ts 才能同时挡住，且新增写入方法时会
    // 自然落在 store.ts 内、必须过审。
    const root = fileURLToPath(new URL('../../..', import.meta.url))
    const srcFiles = [
      ...globSync('packages/*/src/**/*.ts', { cwd: root }),
      ...globSync('apps/web/src/**/*.ts', { cwd: root }),
      ...globSync('apps/web/src/**/*.tsx', { cwd: root }),
    ]
    expect(srcFiles.length).toBeGreaterThan(50)

    const STORE = 'packages/db/src/store.ts'
    const offenders: string[] = []
    for (const rel of srcFiles) {
      const text = readFileSync(join(root, rel), 'utf8')
      if (rel !== STORE && /UPDATE\s+messages\s+SET[^`]*status\s*=\s*['?]/i.test(text)) offenders.push(`${rel}: 裸写 messages.status`)
      if (rel !== STORE && text.includes('setMessageStatus(')) offenders.push(`${rel}: 调用 setMessageStatus`)
    }
    expect(offenders).toEqual([])
  })
})

describe('租约回收后的状态一致性（P1）', () => {
  it('过期租约被重排时，任务同步回「排队中」（不留「消息已排队、任务还在生成中」）', () => {
    const u = store.createUser({ email: 'rq@b.co', passwordHash: 'h', name: 'rq', credits: 10 })
    const t = store.createTopic(u.id, 'T')
    store.deductCredits(u.id, 1, { source: 'generation_charge' })
    const m = store.createMessage({ topicId: t.id, userId: u.id, prompt: 'p', finalPrompt: 'p', size: 'auto', requestedCount: 1, enhancePrompt: false })
    store.syncTopicStatus(t.id, m.id, 'p', 'queued')

    // 认领 → 两侧都应为「在跑」
    store.leaseNextMessage('w1', 60_000)
    expect(store.getMessage(m.id)?.status).toBe('running')
    expect(store.getTopic(t.id)?.status).toBe('running')

    // 把租约改成已过期（模拟 worker 崩溃），再回收
    store.db.prepare('UPDATE messages SET lease_expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', m.id)
    store.requeueExpiredLeases([])

    expect(store.getMessage(m.id)?.status).toBe('queued')
    // 关键：任务侧也必须回到 pending，否则 UI 会一直显示「生成中」而实际在排队
    expect(store.getTopic(t.id)?.status).toBe('pending')
    expect(store.getTopic(t.id)?.activeMessageId).toBe(m.id)
  })

  it('skipIds 里的消息不被回收，其任务状态也不受影响', () => {
    const u = store.createUser({ email: 'rq2@b.co', passwordHash: 'h', name: 'rq2', credits: 10 })
    const t = store.createTopic(u.id, 'T')
    store.deductCredits(u.id, 1, { source: 'generation_charge' })
    const m = store.createMessage({ topicId: t.id, userId: u.id, prompt: 'p', finalPrompt: 'p', size: 'auto', requestedCount: 1, enhancePrompt: false })
    store.syncTopicStatus(t.id, m.id, 'p', 'queued')
    store.leaseNextMessage('w1', 60_000)
    store.db.prepare('UPDATE messages SET lease_expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', m.id)

    store.requeueExpiredLeases([m.id]) // 本进程正在执行 → 不回收

    expect(store.getMessage(m.id)?.status).toBe('running')
    expect(store.getTopic(t.id)?.status).toBe('running')
  })
})

/**
 * #93：消息卡在 canceling 时无恢复路径，未出图额度永久损失。
 *
 * 触发：worker 认领（running）→ 用户取消（canceling）→ worker 在跑到「下一张出图前」的
 * 取消检查点**之前**被重启。此后原 `requeueExpiredLeases` 只回收 running，canceling 永远
 * 没人管；读取自愈又刻意把 canceling 当「在跑」不落定。故这条路径必须由**租约过期**这个
 * 既有信号来收尾：退额 + 消息 canceled + 任务回 idle。
 */
describe('过期 canceling 的租约回收（#93）', () => {
  /** 造「已认领 + 已取消 + 租约可控」的消息（与生产同序：路由只改消息状态，保留租约列） */
  function leasedCanceling(count: number, credits = 20) {
    const u = store.createUser({ email: 'cx@b.co', passwordHash: 'h', name: 'cx', credits })
    const t = store.createTopic(u.id, 'T')
    store.deductCredits(u.id, count, { source: 'generation_charge' })
    const m = store.createMessage({
      topicId: t.id, userId: u.id, prompt: 'p', finalPrompt: 'p', size: 'auto', requestedCount: count, enhancePrompt: false,
    })
    store.syncTopicStatus(t.id, m.id, 'p', 'queued')
    store.leaseNextMessage('w1', 60_000) // 认领：running + 租约 60s（尚不过期）
    store.db.prepare(`UPDATE messages SET status = 'canceling' WHERE id = ?`).run(m.id)
    store.syncTopicStatus(t.id, m.id, 'p', 'canceling')
    return { u, t, m }
  }
  function expireLease(id: string) {
    store.db.prepare('UPDATE messages SET lease_expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', id)
  }
  function seedGenerated(userId: string, topicId: string, messageId: string, n: number) {
    for (let k = 0; k < n; k++) {
      store.insertCanvasImage({
        topicId, userId, messageId, origin: 'generated', name: `图 ${k}`, imageKey: `k-${k}`,
        mimeType: 'image/png', bytes: 1, width: 1, height: 1,
      })
    }
  }
  function refundLedgerCount(userId: string): number {
    return (store.db
      .prepare(`SELECT COUNT(*) AS c FROM credit_ledger WHERE user_id = ? AND source = 'generation_refund'`)
      .get(userId) as { c: number }).c
  }

  it('① 过期 canceling 被回收：消息落 canceled、任务回 idle、按已出图数退额', () => {
    const { u, t, m } = leasedCanceling(5) // 20 − 5 = 15
    seedGenerated(u.id, t.id, m.id, 2) // 已出 2 张
    expireLease(m.id)

    store.requeueExpiredLeases([])

    expect(store.getMessage(m.id)?.status).toBe('canceled')
    // 任务回 idle（而不是被重排回 pending —— 那会违背用户「取消」的意图）
    expect(store.getTopic(t.id)?.status).toBe('idle')
    expect(store.getTopic(t.id)?.activeMessageId).toBeNull()
    // ④ 退额数 = requestedCount − 已落库张数 = 5 − 2 = 3
    expect(store.getUserById(u.id)?.credits).toBe(15 + 3)
    expect(refundLedgerCount(u.id)).toBe(1)
    // 额度守恒：账目与余额一致
    const ov = store.overviewStats()
    expect(ov.credits.ledgerSum).toBe(ov.credits.balance)
  })

  it('② 租约未过期的 canceling 不被回收（不误伤真正在取消中的任务）', () => {
    const { u, t, m } = leasedCanceling(5) // 租约 60s，尚未过期
    seedGenerated(u.id, t.id, m.id, 2)

    store.requeueExpiredLeases([])

    expect(store.getMessage(m.id)?.status).toBe('canceling')
    expect(store.getTopic(t.id)?.status).toBe('canceling')
    expect(store.getUserById(u.id)?.credits).toBe(15) // 未退额
    expect(refundLedgerCount(u.id)).toBe(0)
  })

  it('③ 回收后 worker 再走一次收尾：退额只发生一次（CAS 互斥）', () => {
    const { u, t, m } = leasedCanceling(3) // 20 − 3 = 17
    seedGenerated(u.id, t.id, m.id, 1) // 已出 1 张 → 应退 2
    expireLease(m.id)

    store.requeueExpiredLeases([]) // 回收方先到：退 2
    const afterReclaim = store.getUserById(u.id)!.credits
    expect(afterReclaim).toBe(17 + 2)
    expect(refundLedgerCount(u.id)).toBe(1)

    // 模拟仍活着的 worker 跑到取消收尾（apps/web 的 finishCancel 即调本方法）
    const again = store.finalizeCancel(m.id)
    expect(again.finalized).toBe(false) // 没抢到 CAS
    expect(again.refund).toBe(0)
    expect(store.getUserById(u.id)!.credits).toBe(afterReclaim) // 未二次退额
    expect(refundLedgerCount(u.id)).toBe(1)
    expect(store.getMessage(m.id)?.status).toBe('canceled')
    expect(store.getTopic(t.id)?.status).toBe('idle')
  })

  it('③ 反向竞争：worker 先收尾（租约未过期）后回收再扫到也不二次退额', () => {
    const { u, t, m } = leasedCanceling(3)
    seedGenerated(u.id, t.id, m.id, 1)

    // worker 正常收尾路径（租约还在，这正是 finishCancel 的调用形态）
    const first = store.finalizeCancel(m.id)
    expect(first.finalized).toBe(true)
    expect(first.refund).toBe(2)
    const afterWorker = store.getUserById(u.id)!.credits
    expect(afterWorker).toBe(17 + 2)

    // 稍后租约到期、回收再扫一遍：消息已是 canceled，根本不在候选集内
    expireLease(m.id)
    store.requeueExpiredLeases([])

    expect(store.getUserById(u.id)!.credits).toBe(afterWorker)
    expect(refundLedgerCount(u.id)).toBe(1)
    expect(store.getMessage(m.id)?.status).toBe('canceled')
  })

  it('skipIds 里的过期 canceling 不被回收（本进程在跑，收尾由它自己走）', () => {
    const { u, t, m } = leasedCanceling(3)
    seedGenerated(u.id, t.id, m.id, 1)
    expireLease(m.id)

    store.requeueExpiredLeases([m.id])

    expect(store.getMessage(m.id)?.status).toBe('canceling')
    expect(store.getUserById(u.id)?.credits).toBe(17)
    expect(refundLedgerCount(u.id)).toBe(0)
  })
})

/**
 * #93 同类双退窗口（失败分支）：`executeMessage` 的 catch 过去**自己算退额、自己写状态**，没有 CAS
 * 守卫。一条消息若单次 `provider.generate` 跨过 30 分钟租约（LEASE_MS），另一进程的
 * `requeueExpiredLeases` 可能已把它重排（甚至被重新认领），随后本进程迟到的 catch 会再退一次。
 *
 * 现在失败收尾与 `finalizeCancel` 同构：只有把状态从 `running`（且**执行者身份匹配**）翻走的
 * 那一方退额，另一方退化为 no-op。守卫为什么不止 `status='running'`：重排回 queued 后消息可能被
 * **另一个进程**重新认领成 running（worker_id 换人），只守状态会让原进程误伤别人的在跑轮次。
 */
describe('失败收尾的原子 CAS（finalizeFailure）', () => {
  /** 造「已认领（running + worker_id=w1）」的消息，额度与请求张数可控 */
  function running(count: number, credits = 20) {
    const u = store.createUser({ email: 'ff@b.co', passwordHash: 'h', name: 'ff', credits })
    const t = store.createTopic(u.id, 'T')
    store.deductCredits(u.id, count, { source: 'generation_charge' })
    const m = store.createMessage({
      topicId: t.id, userId: u.id, prompt: 'p', finalPrompt: 'p', size: 'auto', requestedCount: count, enhancePrompt: false,
    })
    store.syncTopicStatus(t.id, m.id, 'p', 'queued')
    store.leaseNextMessage('w1', 60_000)
    return { u, t, m }
  }
  function seedGenerated(userId: string, topicId: string, messageId: string, n: number) {
    for (let k = 0; k < n; k++) {
      store.insertCanvasImage({
        topicId, userId, messageId, origin: 'generated', name: `图 ${k}`, imageKey: `ff-${k}`,
        mimeType: 'image/png', bytes: 1, width: 1, height: 1,
      })
    }
  }
  function expireLease(id: string) {
    store.db.prepare('UPDATE messages SET lease_expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', id)
  }
  function refundRows(userId: string): number {
    return (store.db
      .prepare(`SELECT COUNT(*) AS c FROM credit_ledger WHERE user_id = ? AND source = 'generation_refund'`)
      .get(userId) as { c: number }).c
  }
  const buildError = (refund: number) => `生成失败${refund > 0 ? `，已退还 ${refund} 张额度` : ''}`

  it('① 正常路径：running 失败 → 落 failed、按 requestedCount − 已出图数退额、账目==余额', () => {
    const { u, t, m } = running(5) // 20 − 5 = 15
    seedGenerated(u.id, t.id, m.id, 2) // 已出 2 张 → 应退 3

    const res = store.finalizeFailure(m.id, { workerId: 'w1', buildError })

    expect(res).toEqual({ finalized: true, refund: 3 })
    expect(store.getMessage(m.id)?.status).toBe('failed')
    expect(store.getMessage(m.id)?.error).toBe('生成失败，已退还 3 张额度')
    expect(store.getTopic(t.id)?.status).toBe('idle')
    expect(store.getTopic(t.id)?.activeMessageId).toBeNull()
    expect(store.getUserById(u.id)?.credits).toBe(15 + 3)
    expect(refundRows(u.id)).toBe(1)
    // 额度守恒：账目与余额一致
    const ov = store.overviewStats()
    expect(ov.credits.ledgerSum).toBe(ov.credits.balance)
  })

  it('④ 守卫不误伤：状态仍是 running 且身份匹配 → 必须正常退额（别把正常路径挡掉）', () => {
    const { u, t, m } = running(3) // 20 − 3 = 17
    seedGenerated(u.id, t.id, m.id, 1) // 应退 2
    // 租约即使已过期，只要**身份匹配且状态仍是 running**，失败收尾照样生效 —— 执行者就是当前持有者，
    // 租约过期只意味着「可能被回收」，不代表它已不是执行者（回收真发生时会先把状态翻成 queued）。
    expireLease(m.id)

    const res = store.finalizeFailure(m.id, { workerId: 'w1', buildError })

    expect(res).toEqual({ finalized: true, refund: 2 })
    expect(store.getMessage(m.id)?.status).toBe('failed')
    expect(store.getUserById(u.id)!.credits).toBe(17 + 2)
  })

  it('② 双退防护（正向）：租约重排把状态翻回 queued 后，原进程迟到的失败收尾不得退额', () => {
    const { u, t, m } = running(4) // 20 − 4 = 16
    seedGenerated(u.id, t.id, m.id, 1) // 若误退会是 3
    expireLease(m.id)
    store.requeueExpiredLeases([]) // 回收：**重排回 queued**（不退额）
    expect(store.getMessage(m.id)?.status).toBe('queued')

    // 原进程此刻才抛错（单次 generate 跨过了整个租约）：状态已不是 running → CAS 落空
    const res = store.finalizeFailure(m.id, { workerId: 'w1', buildError })

    expect(res).toEqual({ finalized: false, refund: 0 })
    expect(store.getMessage(m.id)?.status).toBe('queued') // 保持可被重新认领，任务不被误打成 failed
    expect(store.getTopic(t.id)?.status).toBe('pending')
    expect(store.getUserById(u.id)?.credits).toBe(16) // 一分未退
    expect(refundRows(u.id)).toBe(0)
  })

  it('② 变体：重排后被另一进程重新认领，原进程迟到的失败收尾不得退额/改状态（身份守卫）', () => {
    const { u, t, m } = running(4)
    seedGenerated(u.id, t.id, m.id, 1)
    expireLease(m.id)
    store.requeueExpiredLeases([]) // → queued
    expect(store.leaseNextMessage('w2', 60_000)?.id).toBe(m.id) // 另一进程接管 → running, worker_id=w2

    // 原进程 w1 的迟到 catch：状态虽是 running，但身份不是它 → 必须被身份守卫挡住
    const res = store.finalizeFailure(m.id, { workerId: 'w1', buildError })

    expect(res).toEqual({ finalized: false, refund: 0 })
    expect(store.getMessage(m.id)?.status).toBe('running') // 新执行者的轮次不被误伤
    expect(store.getMessage(m.id)?.workerId).toBe('w2')
    expect(store.getTopic(t.id)?.status).toBe('running')
    expect(store.getUserById(u.id)?.credits).toBe(16)
    expect(refundRows(u.id)).toBe(0)
  })

  it('③ 双退防护（反向）：先失败收尾退额，随后回收再扫到也不二次退额', () => {
    const { u, t, m } = running(3) // 20 − 3 = 17
    seedGenerated(u.id, t.id, m.id, 1) // 应退 2
    const first = store.finalizeFailure(m.id, { workerId: 'w1', buildError })
    expect(first).toEqual({ finalized: true, refund: 2 })
    const after = store.getUserById(u.id)!.credits
    expect(after).toBe(17 + 2)

    // 稍后租约过期、回收再扫一遍：消息已是 failed，既不在 running 候选集、也不在 canceling 候选集
    expireLease(m.id)
    store.requeueExpiredLeases([])

    expect(store.getUserById(u.id)!.credits).toBe(after)
    expect(refundRows(u.id)).toBe(1)
    expect(store.getMessage(m.id)?.status).toBe('failed')
    const ov = store.overviewStats()
    expect(ov.credits.ledgerSum).toBe(ov.credits.balance)
  })

  it('幂等：对同一 running 消息重复调用，退额只发生一次', () => {
    const { u, m } = running(2) // 20 − 2 = 18
    expect(store.finalizeFailure(m.id, { workerId: 'w1', buildError })).toEqual({ finalized: true, refund: 2 })
    expect(store.finalizeFailure(m.id, { workerId: 'w1', buildError })).toEqual({ finalized: false, refund: 0 })
    expect(store.getUserById(u.id)!.credits).toBe(18 + 2)
    expect(refundRows(u.id)).toBe(1)
  })

  it('守卫身份不匹配（worker_id 不同）时不退额、状态不动', () => {
    const { u, m } = running(2)
    const res = store.finalizeFailure(m.id, { workerId: 'other', buildError })
    expect(res).toEqual({ finalized: false, refund: 0 })
    expect(store.getMessage(m.id)?.status).toBe('running')
    expect(store.getUserById(u.id)!.credits).toBe(18)
    expect(refundRows(u.id)).toBe(0)
  })
})

/**
 * 成功收尾的原子 CAS（finalizeSuccess）：成功分支过去是**无条件**写入 + 清租约，会覆盖并发的
 * `canceling/failed`，并让另一位执行者的 CAS 静默 no-op。现在与失败/取消收尾同构：守卫
 * 「状态 running + 执行者身份匹配」，命中才落 completed + 清租约 + 任务回 idle。
 */
describe('成功收尾的原子 CAS（finalizeSuccess）', () => {
  function running(count: number, credits = 20) {
    const u = store.createUser({ email: 'fs@b.co', passwordHash: 'h', name: 'fs', credits })
    const t = store.createTopic(u.id, 'T')
    store.deductCredits(u.id, count, { source: 'generation_charge' })
    const m = store.createMessage({
      topicId: t.id, userId: u.id, prompt: 'p', finalPrompt: 'p', size: 'auto', requestedCount: count, enhancePrompt: false,
    })
    store.syncTopicStatus(t.id, m.id, 'p', 'queued')
    store.leaseNextMessage('w1', 60_000)
    return { u, t, m }
  }
  function expireLease(id: string) {
    store.db.prepare('UPDATE messages SET lease_expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', id)
  }

  it('① 正常路径：running + 身份匹配 → completed、清租约、任务回 idle、无流水', () => {
    const { u, t, m } = running(2) // 20 − 2 = 18
    const res = store.finalizeSuccess(m.id, { workerId: 'w1' })

    expect(res).toEqual({ finalized: true })
    expect(store.getMessage(m.id)?.status).toBe('completed')
    expect(store.getMessage(m.id)?.workerId).toBeNull()
    expect(store.getMessage(m.id)?.leaseExpiresAt).toBeNull()
    expect(store.getTopic(t.id)?.status).toBe('idle')
    expect(store.getTopic(t.id)?.activeMessageId).toBeNull()
    // 成功不产生流水（额度守恒：账目 == 余额）
    expect(store.getUserById(u.id)?.credits).toBe(18)
    const ov = store.overviewStats()
    expect(ov.credits.ledgerSum).toBe(ov.credits.balance)
  })

  it('② 身份不匹配（worker_id 不同）→ no-op，不把别人的在跑轮次标成 completed', () => {
    const { u, t, m } = running(2)
    const res = store.finalizeSuccess(m.id, { workerId: 'other' })

    expect(res).toEqual({ finalized: false })
    expect(store.getMessage(m.id)?.status).toBe('running')
    expect(store.getMessage(m.id)?.workerId).toBe('w1')
    expect(store.getTopic(t.id)?.status).toBe('running')
    expect(store.getUserById(u.id)?.credits).toBe(18)
  })

  it('③ 租约被重排回 queued 后，原进程迟到的成功收尾 no-op（不覆盖重排、不误标完成）', () => {
    const { u, t, m } = running(2)
    expireLease(m.id)
    store.requeueExpiredLeases([])
    expect(store.getMessage(m.id)?.status).toBe('queued')

    const res = store.finalizeSuccess(m.id, { workerId: 'w1' })

    expect(res).toEqual({ finalized: false })
    expect(store.getMessage(m.id)?.status).toBe('queued')
    expect(store.getTopic(t.id)?.status).toBe('pending')
    expect(store.getUserById(u.id)?.credits).toBe(18)
  })

  it('⚠️ 回归：并发的 canceling 不被成功收尾覆盖（旧的无条件写入会把它标成 completed）', () => {
    const { u, t, m } = running(3) // 20 − 3 = 17
    // 生成进行中用户取消（保留租约）——与 cancel 路由同序
    store.syncTopicStatus(t.id, m.id, 'p', 'canceling')
    expect(store.markMessageCanceling(m.id)).toBe(true)

    const res = store.finalizeSuccess(m.id, { workerId: 'w1' })

    expect(res).toEqual({ finalized: false })
    expect(store.getMessage(m.id)?.status).toBe('canceling') // 未被覆盖
    expect(store.getTopic(t.id)?.status).toBe('canceling')
    expect(store.getUserById(u.id)?.credits).toBe(17)
  })

  it('幂等：对同一 running 消息重复调用，只有第一次落 completed', () => {
    const { m } = running(1)
    expect(store.finalizeSuccess(m.id, { workerId: 'w1' })).toEqual({ finalized: true })
    expect(store.finalizeSuccess(m.id, { workerId: 'w1' })).toEqual({ finalized: false })
    expect(store.getMessage(m.id)?.status).toBe('completed')
  })
})
