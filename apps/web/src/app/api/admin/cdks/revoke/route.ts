import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, writeAudit } from '@/server/admin'
import { getRuntime } from '@/server/context'
import { jsonError, readJson } from '@/server/http'
import { ServiceError } from '@/server/services'

/** 作废一张未兑换的 CDK */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const actor = requireAdmin(req)
    const { code } = await readJson<{ code?: string }>(req)
    const target = (code ?? '').trim().toUpperCase()
    if (!target) throw new ServiceError(400, '请提供要作废的 CDK 码。')

    const { store } = getRuntime()
    // 用精确查询判存在性 —— 不能用 listCdks({ q })：那是 LIKE 匹配 + LIMIT 1，
    // 当目标码恰好是另一条排序更靠前的记录的子串时，取回的不是目标行 → 会误判 404
    const cdk = store.getCdk(target)
    if (!cdk) throw new ServiceError(404, 'CDK 不存在。')
    const ok = store.revokeCdk(target)
    // 条件 UPDATE 未命中 = 已兑换或已作废：两者都是「不可作废」的冲突态
    if (!ok) throw new ServiceError(409, '该 CDK 已兑换或已作废，无法作废。')

    writeAudit({ actorId: actor.id, action: 'cdk.revoke', targetType: 'cdk', targetId: target })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return jsonError(e)
  }
}
