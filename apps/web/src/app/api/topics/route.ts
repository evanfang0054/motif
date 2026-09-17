import { NextRequest, NextResponse } from 'next/server'
import { getRuntime } from '@/server/context'
import { jsonError, readJson, requireUser } from '@/server/http'

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const user = requireUser(req)
    const topics = getRuntime().store.listTopics(user.id)
    return NextResponse.json({ topics })
  } catch (e) {
    return jsonError(e)
  }
}

/** 手动新建空任务 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const user = requireUser(req)
    const { title } = await readJson<{ title?: string }>(req)
    const topic = getRuntime().store.createTopic(user.id, (title ?? '').trim() || '新任务')
    return NextResponse.json({ topic }, { status: 201 })
  } catch (e) {
    return jsonError(e)
  }
}
