import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/server/admin'
import { getRuntime } from '@/server/context'
import { jsonError } from '@/server/http'

/**
 * 订单列表（只读）。**本模块刻意只导出 GET** —— 管理后台不提供任何改变订单状态
 * 或额度的入口（「订单已支付」必须始终等于真实支付结果）。
 * 若将来确实需要补偿性操作，应新增独立端点并明确审计，而不是在此加写方法。
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    requireAdmin(req)
    const sp = req.nextUrl.searchParams
    const page = Math.max(1, Number(sp.get('page') ?? 1) || 1)
    const pageSize = Math.min(200, Math.max(1, Number(sp.get('pageSize') ?? 50) || 50))
    const userTerm = sp.get('userId') ?? undefined
    const { store } = getRuntime()
    // 筛选词与审计 / 生成日志同一口径：裸 `usr_` ID 精确匹配，邮箱/昵称模糊匹配
    const userIds = userTerm ? store.findUserIdsByTerm(userTerm) : undefined
    const filter = {
      userIds,
      status: sp.get('status') ?? undefined,
      from: sp.get('from') ?? undefined,
      to: sp.get('to') ?? undefined,
    }
    const total = store.countOrders(filter)
    const items = store.listOrders({ ...filter, limit: pageSize, offset: (page - 1) * pageSize })
    return NextResponse.json({ items, total, page, pageSize })
  } catch (e) {
    return jsonError(e)
  }
}
