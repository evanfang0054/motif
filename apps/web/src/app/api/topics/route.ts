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

/** 手动新建空任务：存在可复用的空闲空会话时直接返回它（防空会话堆积） */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const user = requireUser(req)
    const { title } = await readJson<{ title?: string }>(req)
    const store = getRuntime().store
    const existing = store.findReusableTopic(user.id)
    if (existing) return NextResponse.json({ topic: existing, reused: true })
    const topic = store.createTopic(user.id, (title ?? '').trim() || '新任务')
    return NextResponse.json({ topic, reused: false }, { status: 201 })
  } catch (e) {
    return jsonError(e)
  }
}
