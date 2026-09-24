import { NextRequest, NextResponse } from 'next/server'
import type { MessageStatus } from '@motif/core'
import { requireAdmin } from '@/server/admin'
import { getRuntime } from '@/server/context'
import { jsonError } from '@/server/http'

const STATUSES = ['queued', 'running', 'canceling', 'completed', 'failed', 'canceled'] as const

/** 跨用户生成日志（状态 / 用户 / 时间筛选 + 分页） */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    requireAdmin(req)
    const sp = req.nextUrl.searchParams
    const statusRaw = sp.get('status')
    const status = statusRaw && (STATUSES as readonly string[]).includes(statusRaw) ? (statusRaw as MessageStatus) : undefined
    const page = Math.max(1, Number(sp.get('page') ?? 1) || 1)
    const pageSize = Math.min(200, Math.max(1, Number(sp.get('pageSize') ?? 50) || 50))
    const userTerm = sp.get('userId') ?? undefined
    const { store } = getRuntime()
    // 筛选词先解析成人：裸 `usr_` ID 精确匹配，邮箱/昵称模糊匹配（同审计页口径）
    const userIds = userTerm ? store.findUserIdsByTerm(userTerm) : undefined
    const filter = {
      status,
      userIds,
      from: sp.get('from') ?? undefined,
      to: sp.get('to') ?? undefined,
    }

    const total = store.countAllMessages(filter)
    const items = store.listAllMessages({ ...filter, limit: pageSize, offset: (page - 1) * pageSize })
    // 附带昵称/邮箱映射，让列表与详情把 usr_ ID 显示成「昵称（邮箱）」
    const users = store.listUserBriefs(items.map((r) => r.userId))
    return NextResponse.json({ items, total, page, pageSize, users })
  } catch (e) {
    return jsonError(e)
  }
}
