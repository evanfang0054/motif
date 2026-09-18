import { NextRequest, NextResponse } from 'next/server'
import type { UserRole } from '@motif/core'
import { assertCanModifyRole, requireRoot, writeAudit } from '@/server/admin'
import { getRuntime } from '@/server/context'
import { jsonError, readJson } from '@/server/http'
import { ServiceError } from '@/server/services'

/** 改角色（**root 独占**）。admin 不得改任何人的角色，也不得授予 root。 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const actor = requireRoot(req)
    const body = await readJson<{ userId?: string; role?: string }>(req)
    const userId = (body.userId ?? '').trim()
    const role = body.role as UserRole
    if (!userId) throw new ServiceError(400, '缺少目标用户。')
    if (role !== 'user' && role !== 'admin' && role !== 'root') throw new ServiceError(400, '角色只能是 user / admin / root。')

    const { store } = getRuntime()
    const target = store.getUserById(userId)
    if (!target) throw new ServiceError(404, '用户不存在。')
    assertCanModifyRole(actor, target, role)

    const from = target.role
    store.updateUserRole(userId, role)
    writeAudit({ actorId: actor.id, action: 'user.role_change', targetType: 'user', targetId: userId, detail: { from, to: role } })
    return NextResponse.json({ user: store.getUserById(userId)! })
  } catch (e) {
    return jsonError(e)
  }
}
