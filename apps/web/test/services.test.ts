import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hashPassword, verifyPassword } from '@/server/auth'
import {
  enqueueGeneration,
  login,
  redeem,
  register,
  sendCode,
  ServiceError,
} from '@/server/services'
import { MotifStore } from '@motif/db'
import type { ImageProvider } from '@motif/image-provider'
import { SIGNUP_BONUS_CREDITS } from '@motif/core'
import { ConsoleMailer, type MailerConfig } from '@/server/mailer'

let dir: string
let store: MotifStore
// enqueueGeneration 不调用 Provider，测试用最简桩即可
const provider: ImageProvider = {
  name: 'test-stub',
  generate: async () => {
    throw new Error('服务层测试不应触发生成')
  },
}
const mailer: MailerConfig = { mailer: new ConsoleMailer(), isConsole: true }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'motif-svc-'))
  store = new MotifStore(join(dir, 't.db'))
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('auth 流程', () => {
  it('注册：验证码消费 + 赠送额度 + 邀请奖励', async () => {
    const inviter = store.createUser({ email: 'inv@b.co', passwordHash: 'h', name: '邀请人', credits: 0 })
    const { devCode } = await sendCode(store, mailer, 'register', 'new@b.co')
    const user = register(store, {
      name: '新用户',
      email: 'new@b.co',
      code: devCode!,
      password: 'secret66',
      passwordConfirm: 'secret66',
      inviteCode: inviter.inviteCode,
    })
    expect(user.credits).toBe(SIGNUP_BONUS_CREDITS)
    const inviterAfter = store.getUserById(inviter.id)!
    expect(inviterAfter.invitedCount).toBe(1)
    expect(inviterAfter.credits).toBe(3)
    // 验证码已消费，重放失败
    expect(() =>
      register(store, { name: 'x', email: 'new@b.co', code: devCode!, password: 'secret66', passwordConfirm: 'secret66' })
    ).toThrow(ServiceError)
  })

  it('注册：两次密码不一致 / 邮箱重复 / 错误验证码', async () => {
    await sendCode(store, mailer, 'register', 'a@b.co')
    expect(() =>
      register(store, { name: 'a', email: 'a@b.co', code: '000000', password: 'secret66', passwordConfirm: 'other66' })
    ).toThrow(/不一致/)
    const u = store.createUser({ email: 'dup@b.co', passwordHash: 'h', name: 'd' })
    expect(u).toBeTruthy()
    const { devCode } = await sendCode(store, mailer, 'register', 'dup@b.co')
    expect(() =>
      register(store, { name: 'a', email: 'dup@b.co', code: devCode!, password: 'secret66', passwordConfirm: 'secret66' })
    ).toThrow(/已注册/)
  })

  it('登录：正确与错误密码；散列可验证', () => {
    const hash = hashPassword('secret66')
    expect(verifyPassword('secret66', hash)).toBe(true)
    expect(verifyPassword('wrong!!', hash)).toBe(false)
    store.createUser({ email: 'lg@b.co', passwordHash: hash, name: 'lg' })
    expect(login(store, 'lg@b.co', 'secret66').email).toBe('lg@b.co')
    expect(() => login(store, 'lg@b.co', 'nope123')).toThrow(/不正确/)
    expect(() => login(store, 'ghost@b.co', 'secret66')).toThrow(/不正确/)
  })
})

describe('生成流程', () => {
  it('入队：扣额度 + 建任务 + 202 数据完整', async () => {
    const u = store.createUser({ email: 'g@b.co', passwordHash: 'h', name: 'g', credits: 8 })
    const res = await enqueueGeneration(store, provider, dir, u, {
      prompt: '晨光中的白瓷马克杯',
      count: 4,
      size: '1024x1536',
      enhance: false,
      topicId: null,
      referenceCanvasImageIds: [],
    })
    expect(res.queued).toBe(true)
    expect(res.user.credits).toBe(4)
    expect(res.topic.status).toBe('pending')
    expect(res.topic.title.length).toBeGreaterThan(0)
    const msg = store.getMessage(res.messageId)!
    expect(msg.status).toBe('queued')
    expect(msg.requestedCount).toBe(4)
  })

  it('额度不足返回 402', async () => {
    const u = store.createUser({ email: 'p@b.co', passwordHash: 'h', name: 'p', credits: 1 })
    await expect(
      enqueueGeneration(store, provider, dir, u, {
        prompt: '一套 8 张',
        count: 8,
        size: '1024x1024',
        enhance: false,
        topicId: null,
        referenceCanvasImageIds: [],
      })
    ).rejects.toMatchObject({ status: 402 })
  })

  it('他人任务返回 404', async () => {
    const owner = store.createUser({ email: 'o@b.co', passwordHash: 'h', name: 'o' })
    const stranger = store.createUser({ email: 's@b.co', passwordHash: 'h', name: 's', credits: 5 })
    const topic = store.createTopic(owner.id, '私有任务')
    await expect(
      enqueueGeneration(store, provider, dir, stranger, {
        prompt: 'x',
        count: 1,
        size: '1024x1024',
        enhance: false,
        topicId: topic.id,
        referenceCanvasImageIds: [],
      })
    ).rejects.toMatchObject({ status: 404 })
  })

  it('非法输入被拒绝', async () => {
    const u = store.createUser({ email: 'v@b.co', passwordHash: 'h', name: 'v', credits: 5 })
    await expect(
      enqueueGeneration(store, provider, dir, u, { prompt: ' ', count: 1, size: '1024x1024', enhance: false, topicId: null, referenceCanvasImageIds: [] })
    ).rejects.toMatchObject({ status: 400 })
    await expect(
      enqueueGeneration(store, provider, dir, u, { prompt: 'ok', count: 99, size: '1024x1024', enhance: false, topicId: null, referenceCanvasImageIds: [] })
    ).rejects.toMatchObject({ status: 400 })
    await expect(
      enqueueGeneration(store, provider, dir, u, { prompt: 'ok', count: 1, size: '99x99', enhance: false, topicId: null, referenceCanvasImageIds: [] })
    ).rejects.toMatchObject({ status: 400 })
  })

  it('参考图归属校验：他人/跨任务参考图被拒绝，合法参考图计入消息', async () => {
    const owner = store.createUser({ email: 'ro@b.co', passwordHash: 'h', name: 'ro', credits: 9 })
    const stranger = store.createUser({ email: 'rs@b.co', passwordHash: 'h', name: 'rs', credits: 9 })
    const topic = store.createTopic(owner.id, 'T1')
    const otherTopic = store.createTopic(owner.id, 'T2')

    // 本任务合法参考图
    const ref = store.insertCanvasImage({
      topicId: topic.id, userId: owner.id, messageId: null, origin: 'uploaded',
      name: '参考图', imageKey: 'k1', mimeType: 'image/png', bytes: 1, width: 0, height: 0,
    })
    // 其他任务的参考图（同用户）
    const crossRef = store.insertCanvasImage({
      topicId: otherTopic.id, userId: owner.id, messageId: null, origin: 'uploaded',
      name: '参考图', imageKey: 'k2', mimeType: 'image/png', bytes: 1, width: 0, height: 0,
    })

    // 跨任务参考图 → 400
    await expect(
      enqueueGeneration(store, provider, dir, owner, {
        prompt: 'x', count: 1, size: '1024x1024', enhance: false, topicId: topic.id,
        referenceCanvasImageIds: [crossRef.id],
      })
    ).rejects.toMatchObject({ status: 400 })

    // 不存在的参考图 → 400
    await expect(
      enqueueGeneration(store, provider, dir, owner, {
        prompt: 'x', count: 1, size: '1024x1024', enhance: false, topicId: topic.id,
        referenceCanvasImageIds: ['cimg_does_not_exist'],
      })
    ).rejects.toMatchObject({ status: 400 })

    // 合法参考图 → 计入消息 referenceIds
    const res = await enqueueGeneration(store, provider, dir, owner, {
      prompt: '用参考图生成', count: 1, size: '1024x1024', enhance: false, topicId: topic.id,
      referenceCanvasImageIds: [ref.id],
    })
    expect(store.getMessage(res.messageId)!.referenceIds).toEqual([ref.id])

    // 他人冒用 owner 的参考图 → 404（任务都不属于他）
    await expect(
      enqueueGeneration(store, provider, dir, stranger, {
        prompt: 'x', count: 1, size: '1024x1024', enhance: false, topicId: topic.id,
        referenceCanvasImageIds: [ref.id],
      })
    ).rejects.toMatchObject({ status: 404 })
  })
})

describe('CDK 兑换', () => {
  it('成功到账 / 无效 CDK', () => {
    const u = store.createUser({ email: 'c@b.co', passwordHash: 'h', name: 'c', credits: 1 })
    store.createCdk('hello-10', 10)
    expect(redeem(store, u, 'HELLO-10').credits).toBe(11)
    expect(() => redeem(store, u, 'HELLO-10')).toThrow(/无效|已使用/)
    expect(() => redeem(store, u, '')).toThrow(/CDK/)
  })
})
