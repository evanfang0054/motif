import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, writeAudit } from '@/server/admin'
import { getRuntime } from '@/server/context'
import { jsonError, readJson } from '@/server/http'
import { ServiceError } from '@/server/services'

/** 一键标记反馈已处理 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const actor = requireAdmin(req)
    const body = await readJson<{ id?: number }>(req)
    const id = Number(body.id)
    if (!Number.isInteger(id) || id <= 0) throw new ServiceError(400, '缺少要处理的反馈 id。')

    const { store } = getRuntime()
    // 存在性用**精确查询**：不能用 listFeedback({}).some(...) —— 那受分页与排序影响，目标不在当前页时会误判 404
    const fb = store.getFeedback(id)
    if (!fb) throw new ServiceError(404, '反馈不存在。')
    const ok = store.resolveFeedback(id, actor.id)
    if (!ok) throw new ServiceError(409, '该反馈已被处理。')

    writeAudit({ actorId: actor.id, action: 'feedback.resolve', targetType: 'feedback', targetId: String(id) })
    return NextResponse.json({ ok: true, feedback: store.getFeedback(id) })
  } catch (e) {
    return jsonError(e)
  }
}
