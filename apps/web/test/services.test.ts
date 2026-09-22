import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hashPassword, verifyPassword } from '@/server/auth'
import {
  enqueueGeneration,
  friendlyGenerateError,
  login,
  redeem,
  register,
  sendCode,
  ServiceError,
} from '@/server/services'
import { MotifStore } from '@motif/db'
import type { ImageProvider } from '@motif/image-provider'
import { DEFAULT_INVITE_REWARD_CREDITS, DEFAULT_SIGNUP_BONUS_CREDITS, SIGNUP_BONUS_CREDITS } from '@motif/core'
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
    // ⚠️ 邀请活动已改为可配且**默认关闭**（改动前是常量默认生效），故要验奖励必须先打开开关。
    // 这条断言本身没变，变的是前置条件。
    store.setSetting('INVITE_REWARD_ENABLED', 'true')
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

  /** 走完整注册链路（发码 → 注册），可选带邀请码 —— 与上一条用例同一套调用方式 */
  async function registerOne(email: string, inviteCode?: string) {
    const { devCode } = await sendCode(store, mailer, 'register', email)
    return register(store, {
      name: '被邀请人',
      email,
      code: devCode!,
      password: 'secret66',
      passwordConfirm: 'secret66',
      ...(inviteCode ? { inviteCode } : {}),
    })
  }

  const ledgerSum = () => (store.db.prepare('SELECT COALESCE(SUM(delta),0) AS s FROM credit_ledger').get() as { s: number }).s
  const creditsSum = () => (store.db.prepare('SELECT COALESCE(SUM(credits),0) AS s FROM users').get() as { s: number }).s
  /** 领域 User 类型不暴露 invitedBy，直接读列 */
  const invitedByOf = (userId: string) =>
    (store.db.prepare('SELECT invited_by FROM users WHERE id = ?').get(userId) as { invited_by: string | null }).invited_by

  it('关闭邀请活动：不建立邀请关系、不发奖励，但注册赠送照发', async () => {
    store.setSetting('INVITE_REWARD_ENABLED', 'false')
    store.setSetting('SIGNUP_BONUS_CREDITS', '4')
    const inviter = store.createUser({ email: 'off@b.co', passwordHash: 'h', name: '邀请人', credits: 0 })

    const invitee = await registerOne('off-new@b.co', inviter.inviteCode)

    expect(invitee.credits).toBe(4) // 注册赠送不受开关影响
    expect(store.getUserById(inviter.id)!.invitedCount).toBe(0)
    expect(store.getUserById(inviter.id)!.credits).toBe(0)
    expect(invitedByOf(invitee.id)).toBeNull()
    expect(
      (store.db.prepare("SELECT COUNT(*) AS c FROM credit_ledger WHERE source = 'invite_reward'").get() as { c: number }).c
    ).toBe(0)
  })

  it('开启邀请活动：按配置额度发放，且上限可配', async () => {
    store.setSetting('INVITE_REWARD_ENABLED', 'true')
    store.setSetting('INVITE_REWARD_CREDITS', '7')
    store.setSetting('INVITE_REWARD_MAX_INVITEES', '1')
    const inviter = store.createUser({ email: 'on@b.co', passwordHash: 'h', name: '邀请人', credits: 0 })

    const first = await registerOne('on-1@b.co', inviter.inviteCode)
    expect(store.getUserById(inviter.id)!.credits).toBe(7)
    expect(invitedByOf(first.id)).toBe(inviter.id)

    await registerOne('on-2@b.co', inviter.inviteCode)
    expect(store.getUserById(inviter.id)!.credits).toBe(7) // 已达上限：不再增额
    expect(store.getUserById(inviter.id)!.invitedCount).toBe(2) // 但邀请关系仍建立
  })

  it('额度守恒：开关关与开两种配置下都成立', async () => {
    for (const enabled of ['false', 'true']) {
      store.setSetting('INVITE_REWARD_ENABLED', enabled)
      store.setSetting('INVITE_REWARD_CREDITS', '5')
      const inviter = store.createUser({ email: `cons-${enabled}@b.co`, passwordHash: 'h', name: '邀请人', credits: 0 })
      await registerOne(`cons-new-${enabled}@b.co`, inviter.inviteCode)
      expect(ledgerSum(), `enabled=${enabled} 时守恒被破坏`).toBe(creditsSum())
    }
  })

  it('脏配置不影响注册：非法额度回退默认值，不把 NaN 写进额度与流水', async () => {
    // 模拟 .env 里写错值被 seedSettings 不经校验地播种入库（setSetting 正是那条原始写入口）
    store.setSetting('SIGNUP_BONUS_CREDITS', 'abc')
    store.setSetting('INVITE_REWARD_CREDITS', 'abc')
    store.setSetting('INVITE_REWARD_ENABLED', 'true')
    const inviter = store.createUser({ email: 'dirty@b.co', passwordHash: 'h', name: '邀请人', credits: 0 })

    const invitee = await registerOne('dirty-new@b.co', inviter.inviteCode)

    expect(invitee.credits).toBe(DEFAULT_SIGNUP_BONUS_CREDITS)
    expect(store.getUserById(inviter.id)!.credits).toBe(DEFAULT_INVITE_REWARD_CREDITS)
    expect(ledgerSum()).toBe(creditsSum()) // NaN 一旦进库，守恒会立刻不成立
  })

  it('改小额度不回溯既有奖励流水', async () => {
    store.setSetting('INVITE_REWARD_ENABLED', 'true')
    store.setSetting('INVITE_REWARD_CREDITS', '9')
    const inviter = store.createUser({ email: 'hist@b.co', passwordHash: 'h', name: '邀请人', credits: 0 })
    await registerOne('hist-new@b.co', inviter.inviteCode)

    const before = store.db.prepare("SELECT delta FROM credit_ledger WHERE source = 'invite_reward'").all()
    expect(before).toEqual([{ delta: 9 }])

    store.setSetting('INVITE_REWARD_CREDITS', '1')
    expect(store.db.prepare("SELECT delta FROM credit_ledger WHERE source = 'invite_reward'").all()).toEqual(before)
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
    // ⚠️ 这里原本写 `/无效|已使用/`：文案含「已被使用」（「被」夹在中间），
    // 所以第二条分支**从来没匹配过**，一直是靠「无效」那条分支蒙对的。改成精确文案。
    expect(() => redeem(store, u, 'HELLO-10')).toThrow('该 CDK 已被使用。')
    expect(() => redeem(store, u, '')).toThrow(/CDK/)
  })

  it('三种失败原因给出可区分的文案（不存在 / 已作废 / 已使用）', () => {
    const u = store.createUser({ email: 'c2@b.co', passwordHash: 'h', name: 'c2', credits: 0 })

    // ① 码不存在：多半是输错了，提示「检查输入」
    expect(() => redeem(store, u, 'NOPE-XXXX')).toThrow('CDK 无效，请检查是否输入有误。')

    // ② 码被运营作废：不要笼统说「已被使用」，否则用户会以为是自己输错了
    store.createCdk('void-25', 25)
    expect(store.revokeCdk('VOID-25')).toBe(true)
    expect(() => redeem(store, u, 'VOID-25')).toThrow('该 CDK 已失效，请联系发放方。')

    // ③ 码已被兑换过
    store.createCdk('used-25', 25)
    expect(redeem(store, u, 'USED-25').credits).toBe(25)
    expect(() => redeem(store, u, 'USED-25')).toThrow('该 CDK 已被使用。')

    // 三条失败路径都不改额度（原子裁决仍在 store.redeemCdk）
    expect(store.getUserById(u.id)!.credits).toBe(25)
  })
})

describe('friendlyGenerateError（失败文案）', () => {
  it('网关错误剥离原始 JSON 并附退款信息', () => {
    const raw = '生图接口失败（502）：{"error":{"message":"Upstream access forbidden"}}'
    const msg = friendlyGenerateError(raw, 1)
    expect(msg).toContain('网关 502')
    expect(msg).toContain('已退还 1 张额度')
    expect(msg).not.toContain('{"error"')
  })
  it('超时类错误给重试引导', () => {
    expect(friendlyGenerateError('Request timeout after 120s', 2)).toContain('超时')
    expect(friendlyGenerateError('Request timeout after 120s', 2)).toContain('重试')
  })
  it('无退款时不提退款', () => {
    expect(friendlyGenerateError('生图接口失败（500）：oops', 0)).not.toContain('退还')
  })
})
