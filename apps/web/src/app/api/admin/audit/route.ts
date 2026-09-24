import { NextRequest, NextResponse } from 'next/server'
import { requireRoot } from '@/server/admin'
import { getRuntime } from '@/server/context'
import { jsonError } from '@/server/http'

/** 审计流水（**root 独占**）：谁在什么时候对谁做了什么 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    requireRoot(req)
    const sp = req.nextUrl.searchParams
    const page = Math.max(1, Number(sp.get('page') ?? 1) || 1)
    const pageSize = Math.min(200, Math.max(1, Number(sp.get('pageSize') ?? 50) || 50))
    const actorTerm = sp.get('actorId') ?? undefined
    const { store } = getRuntime()
    // 筛选词先解析成人：裸 `usr_` ID 走精确匹配（原样贴 ID 仍可用），邮箱/昵称走模糊匹配。
    // 不解析的话运营只能拿 ID 筛选，而页面上显示的又是 ID —— 谁也认不出是谁。
    const actorIds = actorTerm ? store.findUserIdsByTerm(actorTerm) : undefined
    const filter = {
      userIds: actorIds,
      action: sp.get('action') ?? undefined,
      from: sp.get('from') ?? undefined,
      to: sp.get('to') ?? undefined,
    }

    const total = store.countAudit(filter)
    const items = store.listAuditPaged({ ...filter, limit: pageSize, offset: (page - 1) * pageSize })
    // 附带操作者的昵称/邮箱映射：列表与详情弹窗据此把 usr_ ID 显示成「昵称（邮箱）」。
    // 只带当页引用到的 id，不做全量用户列表。
    const users = store.listUserBriefs(items.map((r) => r.actorId))
    return NextResponse.json({ items, total, page, pageSize, users })
  } catch (e) {
    return jsonError(e)
  }
}
