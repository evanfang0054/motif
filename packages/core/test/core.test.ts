import { describe, expect, it } from 'vitest'
import type { MessageStatus } from '../src/types'
import {
  ACTIVE_MESSAGE_STATUS_VALUES,
  ALLOWED_SIZES,
  COUNT_MAX,
  COUNT_MIN,
  PASSWORD_RULE_TEXT,
  PROMPT_MAX_LEN,
  SIZE_RATIOS,
  clampCount,
  costFor,
  inviteRewardFor,
  isSessionExpiredStatus,
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
  snapCustomSize,
  topicStatusFromMessage,
  validateCount,
  validateEmail,
  validatePassword,
  validatePasswordConfirm,
  validatePrompt,
  validateSize,
  validateTopicTitle,
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

  it('任务名必填（与服务端 trim 后非空的口径一致）', () => {
    expect(validateTopicTitle('新任务')).toBeNull()
    expect(validateTopicTitle('  前后空格  ')).toBeNull()
    expect(validateTopicTitle('')).toBe('请输入任务名称。')
    expect(validateTopicTitle('   ')).toBe('请输入任务名称。')
  })

  it('会话失效判据：401 / 404 才算失效（终止轮询的判据）', () => {
    expect(isSessionExpiredStatus(401)).toBe(true)
    expect(isSessionExpiredStatus(404)).toBe(true)
    expect(isSessionExpiredStatus(400)).toBe(false)
    expect(isSessionExpiredStatus(500)).toBe(false)
    expect(isSessionExpiredStatus(200)).toBe(false)
  })
})

describe('count clamp（#83-1.1 / #78-1.5）', () => {
  it('先四舍五入再钳进 [1,12]', () => {
    expect(clampCount(1)).toBe(1)
    expect(clampCount(12)).toBe(12)
    // 小数：四舍五入到整数，再钳制
    expect(clampCount(1.4)).toBe(1)
    expect(clampCount(1.5)).toBe(2)
    expect(clampCount(1.515)).toBe(2)
    expect(clampCount(0.9)).toBe(1)
    expect(clampCount(0.4)).toBe(1)
    // 越界：先舍后钳（先钳后舍会把 12.6 舍成 13）
    expect(clampCount(12.6)).toBe(12)
    expect(clampCount(13)).toBe(12)
    expect(clampCount(999)).toBe(12)
    expect(clampCount(0)).toBe(1)
    expect(clampCount(-1)).toBe(1)
    // 非有限值兜底到下限，绝不落成 NaN 写进状态
    expect(clampCount(NaN)).toBe(1)
    expect(clampCount(Infinity)).toBe(1)
  })

  it('与 validateCount 同源：clampCount 的结果永远通过校验', () => {
    for (const raw of [-5, 0, 0.4, 1, 1.5, 7.5, 11.6, 12, 12.6, 999, NaN]) {
      expect(validateCount(clampCount(raw)), String(raw)).toBeNull()
    }
    expect(COUNT_MIN).toBe(1)
    expect(COUNT_MAX).toBe(12)
  })
})

describe('custom size snap（#83-1.2）', () => {
  it('保留编辑边，按最近的三档比例推另一边', () => {
    // 编辑宽 → 保宽、推高；当前比例 3.072 最近 3:2 → 高 = round(1536 / 1.5) = 1024
    expect(snapCustomSize('w', 1536, 500)).toEqual({ width: 1536, height: 1024, ratio: '3:2' })
    // 编辑高 → 保高、推宽；当前比例 0.909 最近 1:1 → 宽 = round(1100 × 1) = 1100
    expect(snapCustomSize('h', 1000, 1100)).toEqual({ width: 1100, height: 1100, ratio: '1:1' })
    // 2:3 档：宽 800 → 高 = round(800 / (2/3)) = 1200
    expect(snapCustomSize('w', 800, 1200)).toEqual({ width: 800, height: 1200, ratio: '2:3' })
  })

  it('四舍五入：先算另一边（round），再两边各自钳进 [256,2048]', () => {
    // 999 / 1.5 = 666 → 整数；不出现小数
    expect(snapCustomSize('w', 999, 500).height).toBe(666)
    // 高被推到上限之上 → 钳到 2048，实际比例偏离 3:2（0.977），ratio 为 null（不谎报）
    expect(snapCustomSize('w', 2000, 3000)).toEqual({ width: 2000, height: 2048, ratio: null })
    // 钳制恰好落到另一档（3:2 的高被压到下限后成了 1:1）→ 如实报实际命中的档
    expect(snapCustomSize('w', 256, 200)).toEqual({ width: 256, height: 256, ratio: '1:1' })
  })

  it('非有限输入兜底到下限，不产出 NaN', () => {
    // 钉住具体值而不只断言 isFinite：兜底口径（两轴都取 SIZE_MIN、比例落到 1:1）一旦被改坏，
    // 只查 isFinite 会放行（比如把兜底改成 SIZE_MAX 也「有限」）。
    expect(snapCustomSize('w', NaN, NaN)).toEqual({ width: 256, height: 256, ratio: '1:1' })
    expect(snapCustomSize('h', Infinity, -Infinity)).toEqual({ width: 256, height: 256, ratio: '1:1' })
  })

  it('吸附结果永远能通过 validateSize', () => {
    for (const w of [256, 300, 800, 1024, 1536, 2000, 2048]) {
      const r = snapCustomSize('w', w, 1024)
      expect(validateSize(`${r.width}x${r.height}`).ok, `${w}`).toBe(true)
    }
  })
})

describe('size presets 一致性（ALLOWED_SIZES ↔ SIZE_RATIOS）', () => {
  it('SIZE_RATIOS 由 ALLOWED_SIZES 推导：三档比例逐项一致', () => {
    // SIZE_RATIOS 是**手抄**的三档比例，与 ALLOWED_SIZES 之间原本没有机械关联 ——
    // 改了预设尺寸却忘了同步比例表，界面上的吸附档位就会与真实预设对不上。
    // 这里从 ALLOWED_SIZES 推导出期望值（WxH 约分成 W:H）再逐项比对，把两者钉在一起。
    const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))
    const derived = ALLOWED_SIZES.map((s) => {
      const [w, h] = s.split('x').map(Number)
      const g = gcd(w, h)
      return { key: `${w / g}:${h / g}`, w: w / g, h: h / g }
    })
    expect(SIZE_RATIOS.map((r) => ({ key: r.key, w: r.w, h: r.h }))).toEqual(derived)
    // 三档齐全且互不相同（漏一档或抄重都会在这里暴露）
    expect(new Set(SIZE_RATIOS.map((r) => r.key)).size).toBe(SIZE_RATIOS.length)
  })
})

describe('prompt length（#83-1.3）', () => {
  it('上限常量与校验同源', () => {
    expect(validatePrompt('a'.repeat(PROMPT_MAX_LEN))).toBeNull()
    expect(validatePrompt('a'.repeat(PROMPT_MAX_LEN + 1))).not.toBeNull()
    expect(PROMPT_MAX_LEN).toBe(4000)
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
