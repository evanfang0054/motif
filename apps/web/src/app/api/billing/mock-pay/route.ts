import { NextRequest, NextResponse } from 'next/server'
import { getRuntime } from '@/server/context'
import { jsonError, readJson, requireUser } from '@/server/http'
import { ServiceError, billingMode } from '@/server/services'

/** 模拟收银台支付确认：仅 mock 计费模式可用（线上版由支付渠道回调完成此步） */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const user = requireUser(req)
    if (billingMode(getRuntime().store) === 'live') {
      throw new ServiceError(403, '模拟支付在正式计费模式下不可用。')
    }
    const { orderId } = await readJson<{ orderId: string }>(req)
    const { store } = getRuntime()
    const credits = store.payOrder(orderId, user.id)
    if (credits === null) throw new ServiceError(400, '订单不存在或已支付。')
    const updated = store.addCredits(user.id, credits, { source: 'order_paid', refId: orderId, note: '订单支付到账' })
    return NextResponse.json({ ok: true, paid: credits, user: updated })
  } catch (e) {
    return jsonError(e)
  }
}
