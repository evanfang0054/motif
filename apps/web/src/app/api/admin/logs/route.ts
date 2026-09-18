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
    const filter = {
      status,
      userId: sp.get('userId') ?? undefined,
      from: sp.get('from') ?? undefined,
      to: sp.get('to') ?? undefined,
    }

    const { store } = getRuntime()
    const total = store.countAllMessages(filter)
    const items = store.listAllMessages({ ...filter, limit: pageSize, offset: (page - 1) * pageSize })
    return NextResponse.json({ items, total, page, pageSize })
  } catch (e) {
    return jsonError(e)
  }
}
