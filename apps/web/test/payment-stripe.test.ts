import { describe, expect, it } from 'vitest'
import Stripe from 'stripe'
import { createPaymentGateway } from '@/server/payment'

const SECRET = 'whsec_test_secret'
const gateway = createPaymentGateway('stripe', { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: SECRET })

// 用 stripe-node 自带的测试签名头生成器构造合法签名（不发网络请求）
const client = new Stripe('sk_test_x')
function signedRequest(event: Record<string, unknown>): { raw: string; signature: string } {
  const raw = JSON.stringify(event)
  const signature = client.webhooks.generateTestHeaderString({ payload: raw, secret: SECRET })
  return { raw, signature }
}

const baseSession = {
  id: 'cs_test_1',
  object: 'checkout.session',
  payment_status: 'paid',
  amount_total: 6800,
  metadata: { orderId: 'ord_1' },
}

describe('stripe parseNotifyRaw（webhook 分支）', () => {
  it('checkout.session.completed 且 paid → 提取订单号与金额', async () => {
    const { raw, signature } = signedRequest({
      type: 'checkout.session.completed',
      data: { object: baseSession },
    })
    const r = await gateway.parseNotifyRaw!(raw, signature)
    expect(r).toEqual({ orderId: 'ord_1', amountTotal: 6800 })
  })

  it('completed 但 payment_status 未 paid（异步支付方式资金未确认）→ null 不入账', async () => {
    const { raw, signature } = signedRequest({
      type: 'checkout.session.completed',
      data: { object: { ...baseSession, payment_status: 'unpaid' } },
    })
    expect(await gateway.parseNotifyRaw!(raw, signature)).toBeNull()
  })

  it('非 completed 事件（如 charge.succeeded）→ null 忽略', async () => {
    const { raw, signature } = signedRequest({
      type: 'charge.succeeded',
      data: { object: baseSession },
    })
    expect(await gateway.parseNotifyRaw!(raw, signature)).toBeNull()
  })

  it('缺少 metadata.orderId → 抛错（路由转 400 + 审计）', async () => {
    const { raw, signature } = signedRequest({
      type: 'checkout.session.completed',
      data: { object: { ...baseSession, metadata: {} } },
    })
    await expect(gateway.parseNotifyRaw!(raw, signature)).rejects.toThrow(/metadata\.orderId/)
  })

  it('签名不匹配 → 抛错（路由转 400）', async () => {
    const { raw } = signedRequest({
      type: 'checkout.session.completed',
      data: { object: baseSession },
    })
    await expect(gateway.parseNotifyRaw!(raw, 't=1,v1=deadbeef')).rejects.toThrow()
  })
})
