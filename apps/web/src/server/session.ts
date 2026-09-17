import { NextRequest, NextResponse } from 'next/server'
import { getRuntime } from '@/server/context'
import { SESSION_COOKIE, SESSION_TTL_MS } from '@/server/auth'

/** 登录/注册成功后：签发会话并写入 httpOnly Cookie */
export function createSessionResponse(body: Record<string, unknown>, userId: string, status = 200): NextResponse {
  const { store } = getRuntime()
  const token = store.createSession(userId, SESSION_TTL_MS)
  const res = NextResponse.json(body, { status })
  res.cookies.set({
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: 'lax',
    // HTTPS 部署时设 MOTIF_COOKIE_SECURE=1（本地 http 联调勿开，否则浏览器拒收 cookie）
    secure: process.env.MOTIF_COOKIE_SECURE === '1',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  })
  return res
}

/** 登出：清除会话 */
export function createLogoutResponse(req: NextRequest): NextResponse {
  const token = req.cookies.get(SESSION_COOKIE)?.value
  if (token) getRuntime().store.deleteSession(token)
  const res = NextResponse.json({ ok: true })
  res.cookies.set({ name: SESSION_COOKIE, value: '', path: '/', maxAge: 0 })
  return res
}
