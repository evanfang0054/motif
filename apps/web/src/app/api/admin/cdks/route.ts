import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, writeAudit } from '@/server/admin'
import { getRuntime } from '@/server/context'
import { jsonError, readJson } from '@/server/http'
import { ServiceError } from '@/server/services'

const MAX_BATCH = 100

/** 列表：状态筛选 + 搜索 + 分页 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    requireAdmin(req)
    const sp = req.nextUrl.searchParams
    const statusRaw = sp.get('status')
    const status = statusRaw === 'unredeemed' || statusRaw === 'redeemed' || statusRaw === 'revoked' ? statusRaw : undefined
    const q = sp.get('q') ?? undefined
    const page = Math.max(1, Number(sp.get('page') ?? 1) || 1)
    const pageSize = Math.min(200, Math.max(1, Number(sp.get('pageSize') ?? 50) || 50))

    const { store } = getRuntime()
    const total = store.countCdks({ status, q })
    const items = store.listCdks({ status, q, limit: pageSize, offset: (page - 1) * pageSize })
    return NextResponse.json({ items, total, page, pageSize })
  } catch (e) {
    return jsonError(e)
  }
}

/** 批量生成 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const actor = requireAdmin(req)
    const body = await readJson<{ count?: number; credits?: number; prefix?: string }>(req)
    const count = Number(body.count)
    const credits = Number(body.credits)
    if (!Number.isInteger(count) || count < 1 || count > MAX_BATCH) {
      throw new ServiceError(400, `生成数量需为 1–${MAX_BATCH} 的整数。`)
    }
    if (!Number.isInteger(credits) || credits < 1) throw new ServiceError(400, '面额需为正整数。')
    const prefix = (body.prefix ?? '').trim().toUpperCase().slice(0, 16)

    const codes = getRuntime().store.createCdkBatch({ count, credits, prefix })
    // 审计放在写成功之后；失败只告警不阻断（writeAudit 内部已兜）
    writeAudit({
      actorId: actor.id,
      action: 'cdk.batch_create',
      targetType: 'cdk',
      targetId: codes[0],
      detail: { count, credits, prefix: prefix || null, firstCode: codes[0], lastCode: codes[codes.length - 1] },
    })
    return NextResponse.json({ codes, credits }, { status: 201 })
  } catch (e) {
    return jsonError(e)
  }
}
