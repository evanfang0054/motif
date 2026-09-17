import { NextRequest, NextResponse } from 'next/server'
import { getRuntime } from '@/server/context'
import { jsonError, readJson, requireUser } from '@/server/http'
import { assertOwnedTopic, ServiceError } from '@/server/services'

type Params = { params: Promise<{ id: string }> }

export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  try {
    const user = requireUser(req)
    const { id } = await params
    const detail = getRuntime().store.getTopicDetail(id)
    if (!detail || detail.topic.userId !== user.id) throw new ServiceError(404, '任务不存在。')
    return NextResponse.json(detail)
  } catch (e) {
    return jsonError(e)
  }
}

/** 重命名任务 */
export async function PATCH(req: NextRequest, { params }: Params): Promise<NextResponse> {
  try {
    const user = requireUser(req)
    const { id } = await params
    assertOwnedTopic(getRuntime().store, user.id, id)
    const { title } = await readJson<{ title?: string }>(req)
    const t = (title ?? '').trim()
    if (!t) throw new ServiceError(400, '请输入任务名称。')
    const topic = getRuntime().store.renameTopic(id, t)
    return NextResponse.json({ topic })
  } catch (e) {
    return jsonError(e)
  }
}

export async function DELETE(req: NextRequest, { params }: Params): Promise<NextResponse> {
  try {
    const user = requireUser(req)
    const { id } = await params
    assertOwnedTopic(getRuntime().store, user.id, id)
    getRuntime().store.deleteTopic(id)
    return NextResponse.json({ ok: true })
  } catch (e) {
    return jsonError(e)
  }
}
