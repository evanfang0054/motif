import { NextRequest, NextResponse } from 'next/server'
import { getRuntime } from '@/server/context'
import { jsonError, readJson, requireUser } from '@/server/http'
import { CREDIT_PACKAGES, ServiceError, billingMode } from '@/server/services'

/** 创建充值订单：mock 模式返回本地收银台链接；live 模式待接入真实支付渠道 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const user = requireUser(req)
    const { packageId } = await readJson<{ packageId: string }>(req)
    const pkg = CREDIT_PACKAGES.find((p) => p.id === packageId)
    if (!pkg) throw new ServiceError(400, '套餐不存在。')
    if (billingMode() === 'live') {
      throw new ServiceError(501, '真实支付渠道尚未接入，请使用 CDK 兑换额度。')
    }
    const orderId = getRuntime().store.createOrder(user.id, pkg)
    return NextResponse.json({ orderId, checkoutUrl: `/billing/mock-pay?order=${orderId}` }, { status: 201 })
  } catch (e) {
    return jsonError(e)
  }
}
