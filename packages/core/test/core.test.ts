import { describe, expect, it } from 'vitest'
import type { MessageStatus } from '../src/types'
import {
  ACTIVE_MESSAGE_STATUS_VALUES,
  PASSWORD_RULE_TEXT,
  costFor,
  inviteRewardFor,
  DEFAULT_INVITE_REWARD_CREDITS,
  DEFAULT_INVITE_REWARD_MAX_INVITEES,
  isBusyTopicStatus,
  newCanvasImageId,
  newInviteCode,
  newMessageId,
  newTopicId,
  newUserId,
  newVerificationCode,
  refundFor,
  resolveSize,
  topicStatusFromMessage,
  validateCount,
  validateEmail,
  validatePassword,
  validatePasswordConfirm,
  validatePrompt,
  validateSize,
  validateVerificationCode,
} from '../src/index'

describe('ids', () => {
  it('生成带前缀的 32 位 hex ID', () => {
    expect(newUserId()).toMatch(/^usr_[0-9a-f]{32}$/)
    expect(newTopicId()).toMatch(/^top_[0-9a-f]{32}$/)
    expect(newMessageId()).toMatch(/^msg_[0-9a-f]{32}$/)
    expect(newCanvasImageId()).toMatch(/^cimg_[0-9a-f]{32}$/)
  })
  it('邀请码为 10 位大写字母数字；验证码为 6 位数字', () => {
    expect(newInviteCode()).toMatch(/^[0-9A-Z]{10}$/)
    expect(newVerificationCode()).toMatch(/^\d{6}$/)
  })
  it('ID 不重复', () => {
    const set = new Set(Array.from({ length: 200 }, () => newTopicId()))
    expect(set.size).toBe(200)
  })
})

describe('credits', () => {
  it('费用 = 张数', () => {
    expect(costFor(4)).toBe(4)
    expect(costFor(1)).toBe(1)
  })
  it('退款 = 请求张数 - 已完成张数，且不为负', () => {
    expect(refundFor(8, 3)).toBe(5)
    expect(refundFor(8, 8)).toBe(0)
    expect(refundFor(8, 10)).toBe(0)
    expect(refundFor(8, 0)).toBe(8)
  })
  it('邀请奖励上限 3 人', () => {
    expect(inviteRewardFor(0)).toBe(3)
    expect(inviteRewardFor(2)).toBe(3)
    expect(inviteRewardFor(3)).toBe(0)
    expect(inviteRewardFor(5)).toBe(0)
  })
  it('邀请奖励按传入规则计算，而非写死 3/3', () => {
    expect(inviteRewardFor(0, { credits: 7, maxInvitees: 5 })).toBe(7)
    expect(inviteRewardFor(4, { credits: 7, maxInvitees: 5 })).toBe(7)
    expect(inviteRewardFor(5, { credits: 7, maxInvitees: 5 })).toBe(0)
    expect(inviteRewardFor(99, { credits: 7, maxInvitees: 5 })).toBe(0)
  })
  it('不传规则时回退默认值（保持既有行为）', () => {
    expect(inviteRewardFor(0)).toBe(DEFAULT_INVITE_REWARD_CREDITS)
    expect(inviteRewardFor(DEFAULT_INVITE_REWARD_MAX_INVITEES)).toBe(0)
  })
  it('maxInvitees 为 1 时只有第一个被邀请人得奖励', () => {
    expect(inviteRewardFor(0, { credits: 2, maxInvitees: 1 })).toBe(2)
    expect(inviteRewardFor(1, { credits: 2, maxInvitees: 1 })).toBe(0)
  })
})

describe('validation', () => {
  it('邮箱', () => {
    expect(validateEmail('a@b.co')).toBeNull()
    expect(validateEmail('bad')).not.toBeNull()
    expect(validateEmail('')).not.toBeNull()
  })
  it('密码：≥8 位且同时含大小写字母、数字与符号（D14）', () => {
    expect(validatePassword('Abcd1234!')).toBeNull()
    // 旧规则只看长度，`123456` 被视为合法；D14 收紧后必须被拒
    expect(validatePassword('123456')).not.toBeNull()
    expect(validatePassword('12345')).not.toBeNull()
    // 长度够但缺任一类别都要被拒（四类缺一不可）
    expect(validatePassword('Abcd123')).not.toBeNull() // 长度 7
    expect(validatePassword('abcd1234!')).not.toBeNull() // 缺大写
    expect(validatePassword('ABCD1234!')).not.toBeNull() // 缺小写
    expect(validatePassword('Abcdefg!')).not.toBeNull() // 缺数字
    expect(validatePassword('Abcd1234')).not.toBeNull() // 缺符号
    expect(validatePassword('')).not.toBeNull()
    // 报错文案就是规则本身：用户看到的必须是完整规则，而不是「改一处报一处」试出来
    expect(validatePassword('123456')).toBe(PASSWORD_RULE_TEXT)
  })
  it('确认密码：只判一致性', () => {
    expect(validatePasswordConfirm('Abcd1234!', 'Abcd1234!')).toBeNull()
    expect(validatePasswordConfirm('Abcd1234!', 'Abcd1234?')).toBe('两次输入的密码不一致。')
    // 空与空「一致」——必填由各自的校验负责，这里不重复判
    expect(validatePasswordConfirm('', '')).toBeNull()
  })
  it('验证码为 6 位数字', () => {
    expect(validateVerificationCode('012345')).toBeNull()
    expect(validateVerificationCode('12345')).not.toBeNull()
    expect(validateVerificationCode('abcdef')).not.toBeNull()
  })
  it('提示词必填且限长', () => {
    expect(validatePrompt('一只马克杯')).toBeNull()
    expect(validatePrompt('  ')).not.toBeNull()
    expect(validatePrompt('a'.repeat(4001))).not.toBeNull()
  })
  it('张数 1-12', () => {
    expect(validateCount(1)).toBeNull()
    expect(validateCount(12)).toBeNull()
    expect(validateCount(0)).not.toBeNull()
    expect(validateCount(13)).not.toBeNull()
    expect(validateCount(1.5)).not.toBeNull()
  })
  it('尺寸：预设 / auto / 自定义范围', () => {
    expect(validateSize('1024x1024')).toEqual({ ok: true, value: '1024x1024' })
    expect(validateSize('auto')).toEqual({ ok: true, value: 'auto' })
    expect(validateSize('600x900')).toEqual({ ok: true, value: '600x900' })
    expect(validateSize('100x900').ok).toBe(false)
    expect(validateSize('3000x900').ok).toBe(false)
    expect(validateSize('nonsense').ok).toBe(false)
  })
  it('resolveSize：auto 视为方图', () => {
    expect(resolveSize('auto')).toEqual({ width: 1024, height: 1024 })
    expect(resolveSize('800x1200')).toEqual({ width: 800, height: 1200 })
  })
})

describe('status', () => {
  it('消息状态映射话题状态', () => {
    expect(topicStatusFromMessage('queued')).toBe('pending')
    expect(topicStatusFromMessage('running')).toBe('running')
    expect(topicStatusFromMessage('canceling')).toBe('canceling')
    expect(topicStatusFromMessage('completed')).toBe('idle')
    expect(topicStatusFromMessage('canceled')).toBe('idle')
    expect(topicStatusFromMessage('failed')).toBe('idle')
    expect(topicStatusFromMessage(null)).toBe('idle')
  })

  it('「在跑」话题态只有 pending / running / canceling', () => {
    expect(isBusyTopicStatus('pending')).toBe(true)
    expect(isBusyTopicStatus('running')).toBe(true)
    expect(isBusyTopicStatus('canceling')).toBe(true)
    expect(isBusyTopicStatus('idle')).toBe(false)
    // 终态由 message 携带、topic 会回到 idle，故终态三态都不算「在跑」
    expect(isBusyTopicStatus('completed')).toBe(false)
    expect(isBusyTopicStatus('failed')).toBe(false)
    expect(isBusyTopicStatus('canceled')).toBe(false)
    // 空值不能当成「在跑」：读取自愈会据此判断要不要落定，误判会把好任务 settle 掉
    expect(isBusyTopicStatus(undefined)).toBe(false)
    expect(isBusyTopicStatus(null)).toBe(false)
    expect(isBusyTopicStatus('')).toBe(false)
  })

  it('「在跑的消息态」清单与 topicStatusFromMessage 的推导一致（不得分叉）', () => {
    // 这两个集合是读取自愈的判据：一个说「任务自称在跑」、一个说「消息在跑」。
    // 一旦分叉，自愈就会误伤真正在飞的任务 —— 故把它钉成断言。
    const allMessageStatuses: MessageStatus[] = ['queued', 'running', 'canceling', 'completed', 'failed', 'canceled']
    for (const s of allMessageStatuses) {
      expect(ACTIVE_MESSAGE_STATUS_VALUES.includes(s), s).toBe(isBusyTopicStatus(topicStatusFromMessage(s)))
    }
    // 且清单里不含任何非法值（防止将来有人往 Record 里塞错 key）
    for (const s of ACTIVE_MESSAGE_STATUS_VALUES) expect(allMessageStatuses).toContain(s)
  })
})
