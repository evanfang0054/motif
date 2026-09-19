import { NextRequest, NextResponse } from 'next/server'
import { getRuntime } from '@/server/context'
import { jsonError, readJson, requireUser } from '@/server/http'
import { startCheckout } from '@/server/services'

/** 创建充值订单：mock 渠道返回站内收银台链接，真实渠道返回网关/Stripe 收银页 URL（由服务端分流） */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const user = requireUser(req)
    const { packageId } = await readJson<{ packageId: string }>(req)
    const r = await startCheckout(getRuntime().store, process.env, user.id, packageId ?? '')
    return NextResponse.json(r, { status: 201 })
  } catch (e) {
    return jsonError(e)
  }
}
