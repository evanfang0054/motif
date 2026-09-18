import { NextRequest, NextResponse } from 'next/server'
import { generateStrongPassword } from '@motif/core'
import { requireRoot, writeAudit } from '@/server/admin'
import { hashPassword } from '@/server/auth'
import { getRuntime } from '@/server/context'
import { jsonError, readJson } from '@/server/http'
import { ServiceError } from '@/server/services'

/**
 * 一次性重置密码（**root 独占**）。
 * 明文密码**只在本次响应里出现一次**：不落库、不进审计、不打日志。刷新页面即丢，只能重新重置。
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const actor = requireRoot(req)
    const { userId } = await readJson<{ userId?: string }>(req)
    const target = (userId ?? '').trim()
    if (!target) throw new ServiceError(400, '缺少目标用户。')

    const { store } = getRuntime()
    const user = store.getUserById(target)
    if (!user) throw new ServiceError(404, '用户不存在。')

    const password = generateStrongPassword(20)
    store.updateUserPassword(user.id, hashPassword(password))
    store.setMustChangePassword(user.id, true)
    // 改密必须踢掉既有会话，否则旧会话仍是有效凭证
    store.revokeUserSessions(user.id)

    // 审计只记「谁给谁重置了」，**绝不记明文**
    writeAudit({ actorId: actor.id, action: 'user.reset_password', targetType: 'user', targetId: user.id })
    return NextResponse.json({ user: store.getUserById(user.id)!, password })
  } catch (e) {
    return jsonError(e)
  }
}
