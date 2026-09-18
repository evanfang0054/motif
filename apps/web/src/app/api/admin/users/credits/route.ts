import { NextRequest, NextResponse } from 'next/server'
import type { LedgerEntry } from '@motif/db'
import { assertCanAdjustCredits, requireAdmin, writeAudit } from '@/server/admin'
import { getRuntime } from '@/server/context'
import { jsonError, readJson } from '@/server/http'
import { ServiceError } from '@/server/services'

/**
 * 额度调整（正负均可）。原因必填 —— 没有原因的额度变动等于不可追责。
 * 加额走 addCredits、减额必须走 deductCredits（事务内校验，余额不足不做部分扣减）。
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const actor = requireAdmin(req)
    const body = await readJson<{ userId?: string; delta?: number; reason?: string }>(req)
    const userId = (body.userId ?? '').trim()
    const delta = Number(body.delta)
    const reason = (body.reason ?? '').trim()
    if (!userId) throw new ServiceError(400, '缺少目标用户。')
    if (!Number.isInteger(delta) || delta === 0) throw new ServiceError(400, '调整张数需为非 0 整数。')
    if (!reason) throw new ServiceError(400, '请填写调整原因。')
    if (reason.length > 200) throw new ServiceError(400, '调整原因过长（≤200 字）。')

    const { store } = getRuntime()
    const target = store.getUserById(userId)
    if (!target) throw new ServiceError(404, '用户不存在。')
    assertCanAdjustCredits(actor, target)
    const before = target.credits

    // 第三参数（来源）必填：固定 admin_adjust，并把 reason 写进流水的 note，让流水本身可读
    const entry: LedgerEntry = { source: 'admin_adjust', refId: actor.id, note: reason }
    const updated = delta > 0 ? store.addCredits(userId, delta, entry) : store.deductCredits(userId, -delta, entry)
    if (!updated) throw new ServiceError(409, '该用户额度不足，无法扣减。')

    writeAudit({
      actorId: actor.id,
      action: 'credit.adjust',
      targetType: 'user',
      targetId: userId,
      detail: { delta, reason, before, after: updated.credits },
    })
    return NextResponse.json({ user: updated })
  } catch (e) {
    return jsonError(e)
  }
}
