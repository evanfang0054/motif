import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MotifStore } from '@motif/db'
import { register, sendCode } from '@/server/services'
import type { MailerConfig } from '@/server/mailer'

let dir: string
let store: MotifStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'motif-registration-gate-'))
  store = new MotifStore(join(dir, 't.db'))
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

/** 计数用的 mailer 桩：`Mailer` 接口要求 name + sendVerificationCode + sendTest 三个成员 */
function stubMailer(): { cfg: MailerConfig; count: () => number } {
  let sent = 0
  const cfg: MailerConfig = {
    mailer: {
      name: 'stub',
      sendVerificationCode: async () => {
        sent++
      },
      sendTest: async () => {},
    },
    isConsole: false,
  }
  return { cfg, count: () => sent }
}

const base = {
  name: '小张',
  email: 'a@example.com',
  password: 'Abcd1234!',
  passwordConfirm: 'Abcd1234!',
}

describe('开放注册总开关', () => {
  it('关闭时注册被拒（403），且不创建任何用户行', () => {
    store.setSettings([{ key: 'REGISTRATION_ENABLED', value: 'false' }])
    expect(() => register(store, { ...base, code: '123456' })).toThrowError(/暂未开放注册/)
    expect(store.getUserByEmail('a@example.com')).toBeNull()
  })

  it('关闭时注册发码被拒，且不创建验证码行、不调用 mailer', async () => {
    store.setSettings([{ key: 'REGISTRATION_ENABLED', value: 'false' }])
    const { cfg, count } = stubMailer()
    // ⚠️ 频控（checkRate）是**模块级状态、按邮箱计**，且跨用例不清空 ⇒ 每个发码用例必须用不同邮箱，
    //    否则后一个用例会撞前一个留下的 60s 冷却（「发送过于频繁，请 1 分钟后再试。」）。
    await expect(sendCode(store, cfg, 'register', 'gate-register@example.com')).rejects.toThrowError(/暂未开放注册/)
    expect(count()).toBe(0)
  })

  it('关闭时找回密码发码不受影响', async () => {
    store.setSettings([{ key: 'REGISTRATION_ENABLED', value: 'false' }])
    const { cfg, count } = stubMailer()
    await expect(sendCode(store, cfg, 'password-reset', 'gate-reset@example.com')).resolves.toBeTruthy()
    expect(count()).toBe(1)
  })

  it('默认（键未设置）时注册链路照常', () => {
    // ⚠️ 默认「需邮箱验证码」为 true ⇒ 必须先真的造一个有效码，
    //    否则会撞「验证码无效或已过期。」，这条用例在改动前后都会红。
    const code = store.createVerificationCode('register', 'a@example.com', 60_000)
    const user = register(store, { ...base, code })
    expect(user.email).toBe('a@example.com')
  })
})

describe('注册需邮箱验证码开关', () => {
  it('关闭时不填验证码也能注册', () => {
    store.setSettings([{ key: 'REGISTRATION_REQUIRE_EMAIL_CODE', value: 'false' }])
    const user = register(store, { ...base, code: '' })
    expect(user.email).toBe('a@example.com')
  })

  it('关闭时发码被拒，且文案指出「无需验证码」', async () => {
    store.setSettings([{ key: 'REGISTRATION_REQUIRE_EMAIL_CODE', value: 'false' }])
    const { cfg, count } = stubMailer()
    await expect(sendCode(store, cfg, 'register', 'gate-nocode@example.com')).rejects.toThrowError(/无需邮箱验证码/)
    expect(count()).toBe(0)
  })

  it('开启时验证码必须是 6 位数字：abcdef 被格式判据拒掉（改动前会被接受）', () => {
    store.setSettings([{ key: 'REGISTRATION_REQUIRE_EMAIL_CODE', value: 'true' }])
    // ⚠️ 断言必须打在**格式判据的文案**上：改动前 'abcdef' 会通过 /^.{6}$/，
    //    随后死在 consumeVerificationCode 的「验证码无效或已过期。」—— 只断言 /验证码/ 两边都过，等于没测。
    expect(() => register(store, { ...base, code: 'abcdef' })).toThrowError(/6 位数字/)
  })

  it('注册总开关关闭时，本开关无论开闭都 403', () => {
    store.setSettings([
      { key: 'REGISTRATION_ENABLED', value: 'false' },
      { key: 'REGISTRATION_REQUIRE_EMAIL_CODE', value: 'false' },
    ])
    expect(() => register(store, { ...base, code: '' })).toThrowError(/暂未开放注册/)
  })
})
