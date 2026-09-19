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
 * 验签失败 400（Stripe 按策略重试）；审计 reason 码化（原文只进服务端日志，防上游文案带入敏感片段）。
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { store } = getRuntime()
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local'
  if (!checkRate(`notify:ip:${ip}`, 60_000, 60)) {
    return NextResponse.json({ error: 'too many requests' }, { status: 429 })
  }
  try {
    const gateway = createPaymentGateway('stripe', resolveConfigValues(store, process.env))
    const parsed = await gateway.parseNotify(req)
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
    writeAudit({ actorId: 'system', action: 'billing.notify_rejected', targetType: 'order', detail: { channel: 'stripe', reason, ip } })
    return NextResponse.json({ error: 'invalid signature' }, { status: 400 })
  }
}
