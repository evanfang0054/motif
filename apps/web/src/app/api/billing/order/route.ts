import { NextRequest, NextResponse } from 'next/server'
import { getRuntime } from '@/server/context'
import { jsonError, requireUser } from '@/server/http'
import { ServiceError } from '@/server/services'

/** 结果页轮询：只回状态与到账张数；非本人/不存在订单一律 404（不泄露存在性，也不产生 500 日志噪音） */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const user = requireUser(req)
    const orderId = new URL(req.url).searchParams.get('order') ?? ''
    const order = getRuntime().store.getOrder(orderId)
    if (!order || order.userId !== user.id) throw new ServiceError(404, '订单不存在。')
    return NextResponse.json({
      status: order.status === 'paid' ? 'paid' : 'pending',
      ...(order.status === 'paid' ? { credits: order.credits } : {}),
    })
  } catch (e) {
    return jsonError(e)
  }
}
