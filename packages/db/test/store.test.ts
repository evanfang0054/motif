import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    expect(store.deductCredits(u.id, 4)?.credits).toBe(6)
    expect(store.deductCredits(u.id, 100)).toBeNull()
    expect(store.getUserById(u.id)?.credits).toBe(6)
  })

  it('加额度与邀请计数', () => {
    const u = seedUser()
    store.addCredits(u.id, 5)
    store.recordInvite(u.id, 3)
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
    store.deductCredits(u.id, 8)
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
    store.addCredits(u.id, 8 - 3)
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
