import { NextRequest, NextResponse } from 'next/server'
import { generateStrongPassword, roleAtLeast, validateEmail, validateName, type UserRole, type UserStatus } from '@motif/core'
import { requireAdmin, writeAudit } from '@/server/admin'
import { hashPassword } from '@/server/auth'
import { getRuntime } from '@/server/context'
import { jsonError, readJson } from '@/server/http'
import { ServiceError } from '@/server/services'

const ROLES = ['user', 'admin', 'root'] as const
const STATUSES = ['active', 'disabled'] as const

/** 用户列表（搜索 / 角色 / 状态 / 分页） */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    requireAdmin(req)
    const sp = req.nextUrl.searchParams
    const q = sp.get('q') ?? undefined
    const roleRaw = sp.get('role')
    const statusRaw = sp.get('status')
    const role = roleRaw && (ROLES as readonly string[]).includes(roleRaw) ? (roleRaw as UserRole) : undefined
    const status = statusRaw && (STATUSES as readonly string[]).includes(statusRaw) ? (statusRaw as UserStatus) : undefined
    const page = Math.max(1, Number(sp.get('page') ?? 1) || 1)
    const pageSize = Math.min(200, Math.max(1, Number(sp.get('pageSize') ?? 50) || 50))

    const { store } = getRuntime()
    const total = store.countUsers({ q, role, status })
    const items = store.listUsers({ q, role, status, limit: pageSize, offset: (page - 1) * pageSize })
    return NextResponse.json({ items, total, page, pageSize })
  } catch (e) {
    return jsonError(e)
  }
}

/**
 * 建号。普通管理员可用 —— 它只产出一个「普通用户」，不构成提权；
 * 指定 `admin` 角色才是提权动作，故与「改角色」同口径归 root（见下面的 403）。
 *
 * ⚠️ 与公开注册的邮箱查重口径**故意不同**：注册那边刻意「先消费验证码再查重」以避免
 * 邮箱枚举；这里由**已授权管理员**操作，如实报冲突是必要反馈、不构成枚举风险。
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const actor = requireAdmin(req)
    const body = await readJson<{ email?: string; name?: string; credits?: number; role?: string }>(req)
    const email = (body.email ?? '').trim()
    const name = (body.name ?? '').trim()
    const role = (body.role ?? 'user') as UserRole

    // 非法值 400（含 'root'：本接口不提供建超管的入口）—— 与「提权被拒」的 403 明确区分
    if (role !== 'user' && role !== 'admin') throw new ServiceError(400, '角色只能是普通用户或管理员。')
    if (role === 'admin' && !roleAtLeast(actor.role, 'root')) {
      throw new ServiceError(403, '只有超级管理员可以创建管理员。')
    }
    // 校验复用 core：客户端先行校验用的是同一份判据与同一句文案，避免前后端规则分叉
    const emailErr = validateEmail(email)
    if (emailErr) throw new ServiceError(400, emailErr)
    const nameErr = validateName(name)
    if (nameErr) throw new ServiceError(400, nameErr)
    const credits = body.credits === undefined ? 0 : Number(body.credits)
    if (!Number.isInteger(credits) || credits < 0) throw new ServiceError(400, '初始额度需为非负整数。')

    const { store } = getRuntime()
    if (store.getUserByEmail(email)) throw new ServiceError(409, '该邮箱已被注册。')

    // 明文密码只在本次响应里出现一次：不落库、不进审计、不打日志（与「重置密码」同口径）
    const password = generateStrongPassword(20)
    const user = store.createUser({
      email,
      name,
      passwordHash: hashPassword(password),
      role,
      credits,
      mustChangePassword: true,
    })
    writeAudit({
      actorId: actor.id,
      action: 'user.create',
      targetType: 'user',
      targetId: user.id,
      detail: { email: user.email, role, credits },
    })
    return NextResponse.json({ user, password })
  } catch (e) {
    return jsonError(e)
  }
}
