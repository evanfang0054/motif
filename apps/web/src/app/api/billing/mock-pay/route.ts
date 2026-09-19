import { NextRequest, NextResponse } from 'next/server'
import { getRuntime } from '@/server/context'
import { jsonError, readJson, requireUser } from '@/server/http'
import { ServiceError, paymentChannel } from '@/server/services'

/** 模拟收银台支付确认：仅 mock 渠道 + mock 渠道订单可用（真实渠道由回调完成此步） */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const user = requireUser(req)
    const { store } = getRuntime()
    if (paymentChannel(store) !== 'mock') {
      throw new ServiceError(403, '模拟支付在正式计费模式下不可用。')
    }
    const { orderId } = await readJson<{ orderId: string }>(req)
    // 渠道隔离：mock-pay 只认创建渠道为 mock 的订单 —— 否则「切回 mock 的窗口期」里，
    // 存量的真实渠道 pending 订单可被本人免费用模拟收银台入账（安全评审项）
    const order = store.getOrder(orderId)
    if (!order || order.userId !== user.id) throw new ServiceError(400, '订单不存在或已支付。')
    if (order.channel !== 'mock') throw new ServiceError(403, '模拟支付在正式计费模式下不可用。')
    const credits = store.payOrder(orderId, user.id)
    if (credits === null) throw new ServiceError(400, '订单不存在或已支付。')
    const updated = store.addCredits(user.id, credits, { source: 'order_paid', refId: orderId, note: '订单支付到账' })
    return NextResponse.json({ ok: true, paid: credits, user: updated })
  } catch (e) {
    return jsonError(e)
  }
}
