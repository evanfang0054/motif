import type { NextRequest } from 'next/server'
import type { PaymentGateway } from './types'
import { createStripeGateway } from './stripe'
import { buildEpayPurchaseUrl, verifyEpayNotify } from './epay'

function requireEpayConfig(values: Record<string, string | undefined>) {
  const apiUrl = values.EPAY_API_URL
  const pid = values.EPAY_PID
  const key = values.EPAY_KEY
  if (!apiUrl) throw new Error('缺少 EPAY_API_URL 配置')
  if (!pid) throw new Error('缺少 EPAY_PID 配置')
  if (!key) throw new Error('缺少 EPAY_KEY 配置')
  return { apiUrl, pid, key }
}

/**
 * 支付网关工厂：按渠道现读配置现构造（不进 runtime 缓存，配置保存即热生效）。
 * mock 渠道不走本工厂（checkout 直接返回站内收银台链接）。
 */
export function createPaymentGateway(channel: 'epay' | 'stripe', values: Record<string, string | undefined>): PaymentGateway {
  if (channel === 'stripe') return createStripeGateway(values)
  if (channel !== 'epay') throw new Error(`PAYMENT_CHANNEL 配置非法：${String(channel)}`)
  const cfg = requireEpayConfig(values)
  return {
    name: 'epay',
    async createCheckout(order, urls) {
      const money = (order.amountTotal / 100).toFixed(2) // 分 → 元两位小数（协议金额单位是元）
      return {
        redirectUrl: buildEpayPurchaseUrl(cfg, {
          type: 'alipay',
          outTradeNo: order.orderId,
          name: order.label,
          money,
          notifyUrl: urls.notifyUrl,
          returnUrl: urls.returnUrl,
        }),
      }
    },
    // 注意：此处 parseNotify 仅处理 GET query 形态；POST form 形态的网关通知走 notify 路由
    // （合并 query+form 后统一用 verifyEpayNotify 验签），两处共享同一签名实现避免漂移。
    async parseNotify(req: NextRequest) {
      const params = Object.fromEntries(new URL(req.url).searchParams) as Record<string, string>
      if (!verifyEpayNotify(params, cfg.key).ok) throw new Error('易支付回调验签失败')
      if (params.trade_status !== 'TRADE_SUCCESS') return null // 非成功态忽略
      return { orderId: params.out_trade_no, amountTotal: Math.round(Number(params.money) * 100) }
    },
  }
}
