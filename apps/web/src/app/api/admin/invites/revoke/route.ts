import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, writeAudit } from '@/server/admin'
import { getRuntime } from '@/server/context'
import { jsonError, readJson } from '@/server/http'
import { ServiceError } from '@/server/services'

/** 作废一个未被使用的注册准入码 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const actor = requireAdmin(req)
    const { code } = await readJson<{ code?: string }>(req)
    const target = (code ?? '').trim().toUpperCase()
    if (!target) throw new ServiceError(400, '请提供要作废的注册准入码。')

    // 条件 UPDATE 未命中 = 不存在、已被使用或已作废 —— 三者都是「不可作废」的冲突态
    const ok = getRuntime().store.revokeRegistrationInvite(target)
    if (!ok) throw new ServiceError(400, '该注册准入码不存在、已被使用或已作废。')

    writeAudit({
      actorId: actor.id,
      action: 'registration_invite.revoke',
      targetType: 'registration_invite',
      targetId: target,
    })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return jsonError(e)
  }
}
