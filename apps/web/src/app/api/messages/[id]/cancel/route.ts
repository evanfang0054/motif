import { NextRequest, NextResponse } from 'next/server'
import { getRuntime } from '@/server/context'
import { jsonError, requireUser } from '@/server/http'
import { ServiceError } from '@/server/services'

type Params = { params: Promise<{ id: string }> }

/**
 * 取消生成：未完成张数自动退回额度。
 * queued → 事务内条件取消并全额退；running → 标记 canceling，worker 停止后按剩余退。
 */
export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  try {
    const user = requireUser(req)
    const { id } = await params
    const { store } = getRuntime()
    const result = store.cancelQueuedMessage(id, user.id)
    if (!result.found) throw new ServiceError(404, '任务不存在。')
    if (result.canceled) {
      return NextResponse.json({ ok: true, topic: store.getTopic(id) })
    }

    // 消息已开跑：标记 canceling，由 worker 在下一张出图前停止并按剩余退额
    const msg = store.getMessage(id)
    if (!msg) throw new ServiceError(404, '任务不存在。')
    store.setTopicActive(msg.topicId, id, msg.prompt, 'canceling')
    store.db.prepare(`UPDATE messages SET status = 'canceling' WHERE id = ? AND status = 'running'`).run(id)
    return NextResponse.json({ ok: true, topic: store.getTopic(id) })
  } catch (e) {
    return jsonError(e)
  }
}
