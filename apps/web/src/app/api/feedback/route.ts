import { NextRequest, NextResponse } from 'next/server'
import { getRuntime } from '@/server/context'
import { jsonError, readJson, requireUser } from '@/server/http'
import { ServiceError } from '@/server/services'

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const user = requireUser(req)
    const { content } = await readJson<{ content: string }>(req)
    const c = (content ?? '').trim()
    if (!c) throw new ServiceError(400, '请填写反馈内容。')
    if (c.length > 2000) throw new ServiceError(400, '反馈内容过长。')
    getRuntime().store.insertFeedback(user.id, c)
    return NextResponse.json({ ok: true }, { status: 201 })
  } catch (e) {
    return jsonError(e)
  }
}
