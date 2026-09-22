import { NextRequest, NextResponse } from 'next/server'
import { SESSION_COOKIE, SESSION_TTL_MS } from '@/server/auth'
import { getRuntime } from '@/server/context'
import { ConfigError } from '@/server/config-error'
import { ServiceError } from '@/server/services'
import type { User } from '@motif/core'

/** 通用 API 工具：会话解析、错误包装 */

export function currentUser(req: NextRequest): User | null {
  const token = req.cookies.get(SESSION_COOKIE)?.value
  if (!token) return null
  return getRuntime().store.getUserBySession(token)
}

export function requireUser(req: NextRequest): User {
  const user = currentUser(req)
  if (!user) throw new ServiceError(401, '请先登录。')
  return user
}

/**
 * 统一错误出口。三类分别对待：
 * - `ServiceError`：业务错误，原文回给调用方（文案本就是面向用户的）
 * - `ConfigError`：配置缺失/写坏 —— 换成固定指引回给调用方，内部细节（缺哪些键）只进日志。
 *   若不单独分流，运营看到的会是「服务器开小差了」，只能翻服务器日志才知道是自己没配好。
 * - 其余：真实故障，保留通用兜底文案（避免把内部堆栈/键名泄给调用方）
 */
export function jsonError(e: unknown): NextResponse {
  if (e instanceof ServiceError) {
    return NextResponse.json({ error: e.message }, { status: e.status })
  }
  if (e instanceof ConfigError) {
    console.error('[motif] config error:', e.detail)
    return NextResponse.json({ error: ConfigError.USER_MESSAGE }, { status: 503 })
  }
  console.error('[motif] api error:', e)
  return NextResponse.json({ error: '服务器开小差了，请稍后重试。' }, { status: 500 })
}

export function sessionCookie(token: string): { name: string; value: string; options: Record<string, unknown> } {
  return {
    name: SESSION_COOKIE,
    value: token,
    options: {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_TTL_MS / 1000,
    },
  }
}

export async function readJson<T>(req: NextRequest): Promise<T> {
  try {
    return (await req.json()) as T
  } catch {
    throw new ServiceError(400, '请求体不是合法 JSON。')
  }
}
