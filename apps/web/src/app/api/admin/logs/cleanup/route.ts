import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, writeAudit } from '@/server/admin'
import { getRuntime } from '@/server/context'
import { jsonError, readJson } from '@/server/http'
import { ServiceError } from '@/server/services'

const MIN_DAYS = 1
const MAX_DAYS = 3650
/** 审计最少保留天数：审计是危险区变更与支付拒绝的追责依据，不随请求参数缩到更短 */
const AUDIT_MIN_RETENTION_DAYS = 180

/**
 * 按天清理生成日志与管理审计。**只删已终态且超期的轮次** —— 非终态的账还没结清，删掉等于销毁账目。
 * 管理审计随同一保留期清理（公开回调端点的拒绝记录靠它防灌爆）。
 *
 * 二次确认是必需的：这些记录是额度对账的唯一追溯依据，删了不可恢复。
 * 注意本接口**不碰** `canvas_images`（用户画布资产）与 `credit_ledger`（账目本身）。
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const actor = requireAdmin(req)
    const body = await readJson<{ days?: number; confirm?: boolean }>(req)
    const days = Number(body.days)
    if (!Number.isInteger(days) || days < MIN_DAYS || days > MAX_DAYS) {
      throw new ServiceError(400, `保留天数需为 ${MIN_DAYS}–${MAX_DAYS} 的整数。`)
    }
    if (body.confirm !== true) throw new ServiceError(400, '该操作会永久删除历史对账记录，需要显式确认。')

    const before = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
    const deleted = getRuntime().store.cleanupMessagesBefore(before)
    // 审计保留期取「请求天数 ∨ 180 天」下限：日志可按需清，追责审计不能被一次 days=1 清空
    const auditBefore = new Date(Date.now() - Math.max(days, AUDIT_MIN_RETENTION_DAYS) * 24 * 60 * 60 * 1000).toISOString()
    const auditDeleted = getRuntime().store.deleteAuditBefore(auditBefore)
    writeAudit({ actorId: actor.id, action: 'logs.cleanup', targetType: 'message', detail: { days, before, deleted, auditDeleted, auditBefore } })
    return NextResponse.json({ ok: true, deleted, auditDeleted, before })
  } catch (e) {
    return jsonError(e)
  }
}
