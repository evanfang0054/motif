import Stripe from 'stripe'
import type { CheckoutOrder, CheckoutUrls, PaymentGateway } from './types'

export function createStripeGateway(values: Record<string, string | undefined>): PaymentGateway {
  const key = values.STRIPE_SECRET_KEY
  const webhookSecret = values.STRIPE_WEBHOOK_SECRET
  if (!key) throw new Error('缺少 STRIPE_SECRET_KEY 配置')
  // 不传 apiVersion：stripe-node 每个 release 固定携带自己构建时的 API 版本（lockfile 锁定即确定），
  // 显式写死字面量反而会在升级 SDK 时与类型系统冲突
  const client = new Stripe(key)
  return {
    name: 'stripe',
    async createCheckout(order: CheckoutOrder, urls: CheckoutUrls) {
      const session = await client.checkout.sessions.create({
        mode: 'payment',
        line_items: [
          {
            quantity: 1,
            price_data: { currency: order.currency, unit_amount: order.amountTotal, product_data: { name: order.label } },
          },
        ],
        metadata: { orderId: order.orderId },
        success_url: urls.returnUrl,
        cancel_url: urls.cancelUrl,
      })
      if (!session.url) throw new Error('Stripe 未返回收银页地址')
      return { redirectUrl: session.url }
    },
    async parseNotify(req) {
      if (!webhookSecret) throw new Error('缺少 STRIPE_WEBHOOK_SECRET 配置')
      const raw = await req.text() // 必须是未解析的 raw body（官方 App Router 示例同款）
      const sig = req.headers.get('stripe-signature') ?? ''
      const event = client.webhooks.constructEvent(raw, sig, webhookSecret) // 验签失败抛错
      if (event.type !== 'checkout.session.completed') return null
      const session = event.data.object as Stripe.Checkout.Session
      if (session.payment_status !== 'paid') return null // 异步支付方式资金未确认，不入账
      const orderId = session.metadata?.orderId
      if (!orderId) throw new Error('Stripe 回调缺少 metadata.orderId')
      return { orderId, amountTotal: session.amount_total ?? 0 } // ?? 0 兜底落入 mismatch 拒绝
    },
  }
}
