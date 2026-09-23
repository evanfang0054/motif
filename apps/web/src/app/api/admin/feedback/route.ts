import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/server/admin'
import { getRuntime } from '@/server/context'
import { jsonError } from '@/server/http'

/** 反馈列表（状态筛选 + 分页） */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    requireAdmin(req)
    const sp = req.nextUrl.searchParams
    const statusRaw = sp.get('status')
    const status = statusRaw === 'pending' || statusRaw === 'resolved' ? statusRaw : undefined
    const page = Math.max(1, Number(sp.get('page') ?? 1) || 1)
    const pageSize = Math.min(200, Math.max(1, Number(sp.get('pageSize') ?? 50) || 50))

    const { store } = getRuntime()
    const total = store.countFeedback({ status })
    const items = store.listFeedback({ status, limit: pageSize, offset: (page - 1) * pageSize })
    // 附带昵称/邮箱映射：提交用户与处理人两列都是裸 `usr_` ID，都要能显示成人。
    // 一次把两列引用的 id 一起解析，避免为「处理人」再查一遍。
    const users = store.listUserBriefs(items.flatMap((r) => [r.userId, r.resolvedBy ?? '']))
    return NextResponse.json({ items, total, page, pageSize, users })
  } catch (e) {
    return jsonError(e)
  }
}
