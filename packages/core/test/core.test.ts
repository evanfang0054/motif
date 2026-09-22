import { describe, expect, it } from 'vitest'
import {
  costFor,
  inviteRewardFor,
  DEFAULT_INVITE_REWARD_CREDITS,
  DEFAULT_INVITE_REWARD_MAX_INVITEES,
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
  it('密码至少 6 位', () => {
    expect(validatePassword('123456')).toBeNull()
    expect(validatePassword('12345')).not.toBeNull()
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
})
