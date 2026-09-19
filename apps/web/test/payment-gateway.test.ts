import { describe, expect, it } from 'vitest'
import { createPaymentGateway } from '@/server/payment'

describe('createPaymentGateway 工厂', () => {
  it('epay 缺任一配置 → 抛错且文案含缺失键名', () => {
    expect(() => createPaymentGateway('epay', { EPAY_API_URL: 'https://x' })).toThrow(/EPAY_PID/)
    expect(() => createPaymentGateway('epay', { EPAY_API_URL: 'https://x', EPAY_PID: '1' })).toThrow(/EPAY_KEY/)
  })
  it('stripe 缺 STRIPE_SECRET_KEY → 抛错', () => {
    expect(() => createPaymentGateway('stripe', {})).toThrow(/STRIPE_SECRET_KEY/)
  })
  it('配置齐全时工厂可用（不发起网络请求）', () => {
    expect(() => createPaymentGateway('stripe', { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x' })).not.toThrow()
    expect(() => createPaymentGateway('epay', { EPAY_API_URL: 'https://x', EPAY_PID: '1', EPAY_KEY: 'k' })).not.toThrow()
  })
  it('mock 渠道不走工厂（由 checkout 直接分流），工厂只认 epay/stripe', () => {
    // 类型层面 mock 不可传入；这里验证运行时兜底
    expect(() => createPaymentGateway('mock' as never, {})).toThrow(/PAYMENT_CHANNEL/)
  })
})
