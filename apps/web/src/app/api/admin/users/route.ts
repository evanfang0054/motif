import { NextRequest, NextResponse } from 'next/server'
import type { UserRole, UserStatus } from '@motif/core'
import { requireAdmin } from '@/server/admin'
import { getRuntime } from '@/server/context'
import { jsonError } from '@/server/http'

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
