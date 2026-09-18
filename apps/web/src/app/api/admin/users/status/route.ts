import { NextRequest, NextResponse } from 'next/server'
import type { UserStatus } from '@motif/core'
import { assertCanDisable, requireAdmin, writeAudit } from '@/server/admin'
import { getRuntime } from '@/server/context'
import { jsonError, readJson } from '@/server/http'
import { ServiceError } from '@/server/services'

/**
 * 禁用 / 启用用户。
 *
 * **禁用只吊销会话，明确不退额** —— 正在跑的生成轮次会跑完并按既有规则结算；
 * 额度属于用户资产，与「能不能登录」是两件事。
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const actor = requireAdmin(req)
    const body = await readJson<{ userId?: string; status?: string }>(req)
    const userId = (body.userId ?? '').trim()
    const status = body.status as UserStatus
    if (!userId) throw new ServiceError(400, '缺少目标用户。')
    if (status !== 'active' && status !== 'disabled') throw new ServiceError(400, '状态只能是 active 或 disabled。')

    const { store } = getRuntime()
    const target = store.getUserById(userId)
    if (!target) throw new ServiceError(404, '用户不存在。')
    if (status === 'disabled') assertCanDisable(actor, target)

    const from = target.status
    store.setUserStatus(userId, status)
    // 禁用必须同时吊销既有会话（getUserBySession 也会把禁用用户解析为 null，这里是第二道）
    if (status === 'disabled') store.revokeUserSessions(userId)
    // 注意：**不调用任何退额逻辑**（额度不因禁用而变化）

    writeAudit({
      actorId: actor.id,
      action: status === 'disabled' ? 'user.disable' : 'user.enable',
      targetType: 'user',
      targetId: userId,
      detail: { from, to: status },
    })
    return NextResponse.json({ user: store.getUserById(userId)! })
  } catch (e) {
    return jsonError(e)
  }
}
