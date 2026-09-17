import { NextRequest, NextResponse } from 'next/server'
import { getRuntime } from '@/server/context'
import { jsonError, readJson, requireUser } from '@/server/http'
import { redeem } from '@/server/services'

/** CDK 兑换额度 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const user = requireUser(req)
    const { code } = await readJson<{ code: string }>(req)
    const updated = redeem(getRuntime().store, user, code ?? '')
    return NextResponse.json({ user: updated })
  } catch (e) {
    return jsonError(e)
  }
}
