import type { NextRequest } from 'next/server'

export interface CheckoutOrder {
  orderId: string
  label: string
  /** 最小货币单位（分）整数 */
  amountTotal: number
  /** 三字母 ISO 小写币种 */
  currency: string
}

export interface CheckoutUrls {
  /** 网关服务器对服务器的异步通知地址 */
  notifyUrl: string
  /** 支付完成后浏览器跳回地址 */
  returnUrl: string
  /** 用户取消支付时的跳回地址 */
  cancelUrl: string
}

export interface PaymentGateway {
  readonly name: 'epay' | 'stripe'
  createCheckout(order: CheckoutOrder, urls: CheckoutUrls): Promise<{ redirectUrl: string }>
  /** 验签并提取订单信息；null = 非入账事件（忽略）；验签失败抛错（路由转拒绝） */
  parseNotify(req: NextRequest): Promise<{ orderId: string; amountTotal: number } | null>
  /** raw-body 形态（webhook 路由预读 body 一次，失败审计降噪要复用 raw 提取订单号）；实现了就优先走它 */
  parseNotifyRaw?(raw: string, signature: string): Promise<{ orderId: string; amountTotal: number } | null>
}
