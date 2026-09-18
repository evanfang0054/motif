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
    const filter = {
      actorId: sp.get('actorId') ?? undefined,
      action: sp.get('action') ?? undefined,
      from: sp.get('from') ?? undefined,
      to: sp.get('to') ?? undefined,
    }

    const { store } = getRuntime()
    const total = store.countAudit(filter)
    const items = store.listAuditPaged({ ...filter, limit: pageSize, offset: (page - 1) * pageSize })
    return NextResponse.json({ items, total, page, pageSize })
  } catch (e) {
    return jsonError(e)
  }
}
