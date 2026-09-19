import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MotifStore } from '@motif/db'
import { paymentChannel, sendCode } from '@/server/services'

let dir: string
let store: MotifStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'motif-settings-danger-'))
  store = new MotifStore(join(dir, 't.db'))
  delete process.env.PAYMENT_CHANNEL
  delete process.env.MOTIF_EXPOSE_DEV_CODE
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
  vi.unstubAllEnvs()
  delete process.env.PAYMENT_CHANNEL
  delete process.env.MOTIF_EXPOSE_DEV_CODE
})

describe('支付渠道读配置而不是读环境变量', () => {
  it('默认 mock', () => {
    expect(paymentChannel(store)).toBe('mock')
  })

  it('库里的值压过环境变量（正对照：只读 env 的实现会红在这条）', () => {
    process.env.PAYMENT_CHANNEL = 'mock'
    store.setSetting('PAYMENT_CHANNEL', 'epay')
    expect(paymentChannel(store)).toBe('epay')
  })

  it('库里没有该键时回退环境变量（升级前的部署行为不变）', () => {
    process.env.PAYMENT_CHANNEL = 'epay'
    // 数据库无该键时 resolveSetting 返回环境变量的值，所以这里**就是** 'epay'。
    // 这条断言守的是「老部署只设环境变量也能照旧生效」。
    expect(paymentChannel(store)).toBe('epay')
  })

  it('未知值兜底 mock（fail-safe）', () => {
    store.setSetting('PAYMENT_CHANNEL', 'paypal')
    expect(paymentChannel(store)).toBe('mock')
  })
})

describe('验证码直出开关读配置', () => {
  const consoleMailer = { mailer: { name: 'console', sendVerificationCode: async () => {} }, isConsole: true }

  it('生产环境下默认不直出', async () => {
    // 用 vi.stubEnv 而不是直接给 process.env.NODE_ENV 赋值：NODE_ENV 在类型里是 readonly
    // 字面量联合，直接赋值要么报错、要么得挂 @ts-expect-error（而一旦它其实不报错，
    // @ts-expect-error 自己就变成「未使用的指令」错误）。
    vi.stubEnv('NODE_ENV', 'production')
    const r = await sendCode(store, consoleMailer as never, 'register', 'a@b.co')
    expect(r.devCode).toBeUndefined()
  })

  it('库里打开开关后，生产环境下也直出（正对照：只读 env 的实现会红在这条）', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    store.setSetting('MOTIF_EXPOSE_DEV_CODE', 'true')
    const r = await sendCode(store, consoleMailer as never, 'register', 'c@b.co')
    expect(r.devCode).toMatch(/^\d{6}$/)
  })

  it('真实渠道（isConsole=false）永不直出，即使开关打开', async () => {
    store.setSetting('MOTIF_EXPOSE_DEV_CODE', 'true')
    const r = await sendCode(
      store,
      { mailer: { name: 'smtp', sendVerificationCode: async () => {} }, isConsole: false } as never,
      'register',
      'd@b.co'
    )
    expect(r.devCode).toBeUndefined()
  })
})
