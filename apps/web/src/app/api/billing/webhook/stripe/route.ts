import { NextRequest, NextResponse } from 'next/server'
import { writeAudit } from '@/server/admin'
import { getRuntime } from '@/server/context'
import { resolveConfigValues } from '@/server/settings'
import { createPaymentGateway } from '@/server/payment'
import { creditPaidOrder } from '@/server/services'
import { checkRate } from '@/server/rate-limit'

/**
 * Stripe webhook：raw body + stripe-signature 验签（constructEvent，官方 App Router 示例同款）。
 * checkout.session.completed 且 payment_status==='paid' → creditPaidOrder 幂等入账；其余事件 200 忽略。
 * 验签失败 400（Stripe 按策略重试）；审计降噪与 epay 路由同款——只有 raw body 里的订单号命中
 * 「存在且 pending」的订单才入库，扫描器/伪造流量只进服务端日志（audit 表写入面就此关闭）。
 * 频控 key 说明：x-forwarded-for 可伪造，但审计降噪已把持久化写面关掉，伪造头最多烧掉限流配额本身。
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { store } = getRuntime()
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local'
  if (!checkRate(`notify:ip:${ip}`, 60_000, 60)) {
    return NextResponse.json({ error: 'too many requests' }, { status: 429 })
  }

  const raw = await req.text() // 单次读取；失败审计降噪要用同一份 raw 提取订单号
  try {
    const gateway = createPaymentGateway('stripe', resolveConfigValues(store, process.env))
    const parsed =
      gateway.parseNotifyRaw
        ? await gateway.parseNotifyRaw(raw, req.headers.get('stripe-signature') ?? '')
        : await gateway.parseNotify(req)
    if (parsed === null) return NextResponse.json({ received: true }) // 非入账事件（含未 paid）
    const result = creditPaidOrder(store, parsed.orderId, parsed.amountTotal)
    if (result === 'not_found') {
      writeAudit({ actorId: 'system', action: 'billing.notify_rejected', targetType: 'order', targetId: parsed.orderId, detail: { channel: 'stripe', reason: 'order_not_found', ip } })
      return NextResponse.json({ error: 'order not found' }, { status: 400 })
    }
    if (result === 'mismatch') {
      writeAudit({ actorId: 'system', action: 'billing.notify_rejected', targetType: 'order', targetId: parsed.orderId, detail: { channel: 'stripe', reason: 'amount_mismatch', ip } })
      return NextResponse.json({ error: 'amount mismatch' }, { status: 400 })
    }
    return NextResponse.json({ received: true })
  } catch (e) {
    console.error('[billing] stripe webhook error:', e) // 原文只进服务端日志
    const msg = e instanceof Error ? e.message : ''
    const reason = /signature/i.test(msg) ? 'bad_sign' : /缺少|misconfig/i.test(msg) ? 'misconfigured' : 'bad_payload'
    // 验签失败不可信正文，但 raw 里的 metadata.orderId 仍可作为「是否值得留痕」的过滤器：
    // 只有命中真实 pending 订单的失败才写审计（疑似针对性伪造），其余扫描流量只留日志
    let suspectOrderId: string | undefined
    try {
      suspectOrderId = (JSON.parse(raw) as { data?: { object?: { metadata?: { orderId?: string } } } })?.data?.object?.metadata?.orderId
    } catch {
      /* 非 JSON body：保持 undefined */
    }
    const suspect = suspectOrderId ? store.getOrder(suspectOrderId) : undefined
    if (suspect?.status === 'pending') {
      writeAudit({ actorId: 'system', action: 'billing.notify_rejected', targetType: 'order', targetId: suspectOrderId, detail: { channel: 'stripe', reason, ip } })
    } else {
      console.warn(`[billing] stripe webhook 验签失败已忽略 ip=${ip} reason=${reason}`)
    }
    return NextResponse.json({ error: 'invalid signature' }, { status: 400 })
  }
}
