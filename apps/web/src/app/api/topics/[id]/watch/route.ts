import { NextRequest, NextResponse } from 'next/server'
import { getRuntime } from '@/server/context'
import { requireUser } from '@/server/http'
import { ServiceError } from '@/server/services'

type Params = { params: Promise<{ id: string }> }

const POLL_INTERVAL_MS = 500
const MAX_HOLD_MS = 20_000

/**
 * 任务状态长轮询（watch）：
 * 客户端携带 since（话题的 updatedAt），服务端在话题发生变化时立即返回，
 * 或挂起最多 20 秒后返回 changed:false，让前端即时感知生成进度。
 */
export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  try {
    const user = requireUser(req)
    const { id } = await params
    const { store } = getRuntime()
    const topic = store.getTopic(id)
    if (!topic || topic.userId !== user.id) throw new ServiceError(404, '任务不存在。')

    const since = req.nextUrl.searchParams.get('since') ?? ''
    const started = Date.now()

    while (Date.now() - started < MAX_HOLD_MS) {
      const current = store.getTopic(id)
      if (!current) throw new ServiceError(404, '任务不存在。')
      if (since && current.updatedAt !== since) {
        return NextResponse.json({ changed: true, topic: current })
      }
      if (!since && current) {
        // 未带 since：立即返回当前状态，作为版本基线
        return NextResponse.json({ changed: false, topic: current })
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    }
    const current = store.getTopic(id)
    return NextResponse.json({ changed: false, topic: current })
  } catch (e) {
    const { jsonError } = await import('@/server/http')
    return jsonError(e)
  }
}
