import { NextRequest, NextResponse } from 'next/server'
import { getRuntime } from '@/server/context'
import { readJson, jsonError, requireUser } from '@/server/http'
import { ServiceError } from '@/server/services'
import { hashPassword, verifyPassword, SESSION_COOKIE } from '@/server/auth'
import { validatePassword } from '@motif/core'

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const user = requireUser(req)
    const { oldPassword, newPassword } = await readJson<{ oldPassword: string; newPassword: string }>(req)
    const err = validatePassword(newPassword ?? '')
    if (err) throw new ServiceError(400, err)
    const { store } = getRuntime()
    const stored = store.getPasswordHash(user.id)
    if (!stored || !verifyPassword(oldPassword ?? '', stored)) throw new ServiceError(401, '当前密码不正确。')
    store.updateUserPassword(user.id, hashPassword(newPassword))
    // 凭证变更即吊销其他会话（保留当前会话，避免把自己踢下线）
    store.revokeUserSessions(user.id, req.cookies.get(SESSION_COOKIE)?.value)
    return NextResponse.json({ ok: true })
  } catch (e) {
    return jsonError(e)
  }
}
