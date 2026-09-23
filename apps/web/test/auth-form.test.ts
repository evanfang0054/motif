import { describe, expect, it } from 'vitest'
import { PASSWORD_RULE_TEXT, validatePasswordConfirm } from '@motif/core'
import { clientAuthError, isFormFilled, switchAuthFields, type AuthFieldState } from '@/lib/auth-form'

/**
 * 覆盖本批新增的三条纯逻辑（`clientAuthError` / `isFormFilled` / `switchAuthFields`）。
 * 纯函数、无 React / DOM 依赖，故直接跑在默认的 node 环境下，不引入 jsdom / testing-library。
 */

/** 一份「填满且全部合规」的字段值：各用例只覆盖自己关心的那一项 */
const filled: AuthFieldState = {
  name: '小美',
  email: 'me@example.com',
  code: '123456',
  password: 'Passw0rd!',
  passwordConfirm: 'Passw0rd!',
  inviteCode: 'INVITE01',
}

const empty = { name: '', email: '', code: '', password: '', passwordConfirm: '' }

describe('clientAuthError：客户端先行校验（#74-2.2 必填 / #74-2.1 密码规则 / #80-1.1 内联报错）', () => {
  it('注册：空表单按填写顺序一次只报一条（昵称 → 邮箱 → 验证码 → 密码 → 确认密码）', () => {
    expect(clientAuthError('register', empty)).toBe('请输入昵称。')
    expect(clientAuthError('register', { ...empty, name: '小美' })).toBe('请输入邮箱。')
    expect(clientAuthError('register', { ...empty, name: '小美', email: 'me@example.com' })).toBe('请输入 6 位邮箱验证码。')
    expect(clientAuthError('register', { ...empty, name: '小美', email: 'me@example.com', code: '123456' })).toBe('请输入密码。')
    expect(
      clientAuthError('register', { ...empty, name: '小美', email: 'me@example.com', code: '123456', password: 'Passw0rd!' })
    ).toBe('请再次输入密码。')
  })

  it('注册：只缺昵称也照样拦住（不能因为别的填了就先放行）', () => {
    expect(clientAuthError('register', { ...filled, name: '   ' })).toBe('请输入昵称。')
  })

  it('注册：邮箱格式错误 → core 的邮箱文案', () => {
    expect(clientAuthError('register', { ...filled, email: 'not-an-email' })).toBe('请输入有效的邮箱地址。')
  })

  it('注册：验证码非 6 位数字 → core 的验证码文案', () => {
    expect(clientAuthError('register', { ...filled, code: 'abcdef' })).toBe('验证码应为 6 位数字。')
  })

  it('注册：密码不合规（长度够但缺大写/符号）→ PASSWORD_RULE_TEXT', () => {
    expect(clientAuthError('register', { ...filled, password: '12345678', passwordConfirm: '12345678' })).toBe(PASSWORD_RULE_TEXT)
  })

  it('注册：两次密码不一致 → 与 core 同一句文案', () => {
    const err = clientAuthError('register', { ...filled, passwordConfirm: 'Passw0rd?' })
    expect(err).toBe(validatePasswordConfirm(filled.password, 'Passw0rd?'))
    expect(err).toContain('不一致')
  })

  it('注册：全部合规 → null（放行给服务端）', () => {
    expect(clientAuthError('register', filled)).toBeNull()
  })

  it('找回密码：空表单按顺序报（邮箱 → 验证码 → 新密码），且不校验确认密码', () => {
    expect(clientAuthError('reset', empty)).toBe('请输入邮箱。')
    expect(clientAuthError('reset', { ...empty, email: 'me@example.com' })).toBe('请输入 6 位邮箱验证码。')
    expect(clientAuthError('reset', { ...empty, email: 'me@example.com', code: '123456' })).toBe('请输入新密码。')
    // 确认密码不是本视图的字段（表单里根本没有），填了也只按上面三条判
    expect(clientAuthError('reset', { ...filled, passwordConfirm: '完全不一样' })).toBeNull()
  })

  it('找回密码：新密码不合规（含长度不足 8）→ PASSWORD_RULE_TEXT', () => {
    expect(clientAuthError('reset', { ...filled, password: '12345678' })).toBe(PASSWORD_RULE_TEXT)
    expect(clientAuthError('reset', { ...filled, password: 'Ab1!' })).toBe(PASSWORD_RULE_TEXT)
  })

  it('登录：只拦空值，格式与复杂度一律交给服务端（不泄露账号是否存在、不锁死存量弱密码账号）', () => {
    expect(clientAuthError('login', { ...filled, email: '' })).toBe('请输入邮箱。')
    expect(clientAuthError('login', { ...filled, password: '' })).toBe('请输入密码。')
    expect(clientAuthError('login', { ...filled, email: 'not-an-email' })).toBeNull()
    expect(clientAuthError('login', { ...filled, password: '123' })).toBeNull()
    expect(clientAuthError('login', filled)).toBeNull()
  })
})

describe('isFormFilled：提交按钮的置灰判据（#74-2.2）', () => {
  it('注册要求五个字段全非空', () => {
    expect(isFormFilled('register', filled)).toBe(true)
    expect(isFormFilled('register', { ...filled, name: '' })).toBe(false)
    expect(isFormFilled('register', { ...filled, email: '' })).toBe(false)
    expect(isFormFilled('register', { ...filled, code: '' })).toBe(false)
    expect(isFormFilled('register', { ...filled, password: '' })).toBe(false)
    expect(isFormFilled('register', { ...filled, passwordConfirm: '' })).toBe(false)
  })

  it('只判「非空」不判规则：不合规的密码也算填了（让用户点下去拿到具体原因）', () => {
    expect(isFormFilled('register', { ...filled, password: '1', passwordConfirm: '1' })).toBe(true)
    expect(isFormFilled('reset', { ...filled, password: '1' })).toBe(true)
  })

  it('找回密码只看邮箱 / 验证码 / 新密码', () => {
    expect(isFormFilled('reset', { ...filled, name: '', passwordConfirm: '' })).toBe(true)
    expect(isFormFilled('reset', { ...filled, code: '' })).toBe(false)
  })

  it('登录只看邮箱 / 密码', () => {
    expect(isFormFilled('login', { ...filled, name: '', code: '', passwordConfirm: '' })).toBe(true)
    expect(isFormFilled('login', { ...filled, password: '' })).toBe(false)
  })
})

describe('switchAuthFields：切视图只保留邮箱与邀请码（#80-1.2）', () => {
  it('密码类字段被清空 —— 登录密码不得被带进「找回密码」的新密码框', () => {
    const next = switchAuthFields(filled, 'reset')
    expect(next.password).toBe('')
    expect(next.passwordConfirm).toBe('')
  })

  it('昵称与验证码被清空（视图私有字段；注册与重置的验证码用途不同，不可复用）', () => {
    const next = switchAuthFields(filled, 'login')
    expect(next.name).toBe('')
    expect(next.code).toBe('')
  })

  it('邮箱与邀请码保留（邮箱三视图共用；邀请码是入口上下文，清掉会静默丢奖励）', () => {
    for (const target of ['login', 'register', 'reset'] as const) {
      const next = switchAuthFields(filled, target)
      expect(next.email).toBe('me@example.com')
      expect(next.inviteCode).toBe('INVITE01')
    }
  })

  it('清空集合与目标视图无关（三种目标结果一致）', () => {
    const login = switchAuthFields(filled, 'login')
    expect(switchAuthFields(filled, 'register')).toEqual(login)
    expect(switchAuthFields(filled, 'reset')).toEqual(login)
  })

  it('是纯函数：不改动入参', () => {
    switchAuthFields(filled, 'login')
    expect(filled.password).toBe('Passw0rd!')
    expect(filled.passwordConfirm).toBe('Passw0rd!')
    expect(filled.name).toBe('小美')
    expect(filled.code).toBe('123456')
  })
})
