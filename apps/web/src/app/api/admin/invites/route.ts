import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, writeAudit } from '@/server/admin'
import { getRuntime } from '@/server/context'
import { jsonError, readJson } from '@/server/http'
import { ServiceError } from '@/server/services'

const MAX_BATCH = 100

/** 列表：分页（准入码没有状态筛选/搜索，一码一行、量级有限） */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    requireAdmin(req)
    const sp = req.nextUrl.searchParams
    const page = Math.max(1, Number(sp.get('page') ?? 1) || 1)
    const pageSize = Math.min(200, Math.max(1, Number(sp.get('pageSize') ?? 50) || 50))

    const { store } = getRuntime()
    const items = store.listRegistrationInvites({ limit: pageSize, offset: (page - 1) * pageSize })
    return NextResponse.json({ items, page, pageSize })
  } catch (e) {
    return jsonError(e)
  }
}

/** 批量发放 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const actor = requireAdmin(req)
    const body = await readJson<{ count?: number; note?: string }>(req)
    const count = Number(body.count ?? 1)
    if (!Number.isInteger(count) || count < 1 || count > MAX_BATCH) {
      throw new ServiceError(400, `发放数量需为 1–${MAX_BATCH} 的整数。`)
    }
    const note = (body.note ?? '').trim() || undefined

    const codes = getRuntime().store.createRegistrationInviteBatch({ count, note, createdBy: actor.id })
    // 审计放在写成功之后；失败只告警不阻断（writeAudit 内部已兜）
    writeAudit({
      actorId: actor.id,
      action: 'registration_invite.batch_create',
      targetType: 'registration_invite',
      targetId: codes[0],
      detail: { count, note: note ?? null, firstCode: codes[0], lastCode: codes[codes.length - 1] },
    })
    return NextResponse.json({ codes }, { status: 201 })
  } catch (e) {
    return jsonError(e)
  }
}
