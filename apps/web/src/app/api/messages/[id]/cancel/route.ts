import { NextRequest, NextResponse } from 'next/server'
import { isCancelableMessageStatus } from '@motif/core'
import { getRuntime } from '@/server/context'
import { jsonError, requireUser } from '@/server/http'
import { ServiceError } from '@/server/services'

type Params = { params: Promise<{ id: string }> }

/**
 * 取消生成：未完成张数自动退回额度。
 * queued → 事务内条件取消并全额退；running → 标记 canceling，worker 停止后按剩余退。
 *
 * ⚠️ **终态守卫**：取消是可重复调用的接口，对已落终态的轮次必须**幂等** ——
 * 返回当前状态、**不改变任务状态**。原先这里无条件把任务置为 `canceling`，而紧随其后的
 * messages UPDATE 只匹配 `status='running'`，于是对一条已失败/已完成的轮次再点一次取消，
 * 消息不动、任务却被置成「正在停止生成」，此后没有任何路径把它落定（#81 实测卡死 2h45m）。
 */
export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  try {
    const user = requireUser(req)
    const { id } = await params
    const { store } = getRuntime()
    const result = store.cancelQueuedMessage(id, user.id)
    if (!result.found) throw new ServiceError(404, '任务不存在。')

    // ⚠️ 这里取的是**消息**（路由参数是 message id），topic 必须经 msg.topicId 拿 ——
    // 早先三处回包都写成 `store.getTopic(id)`，拿消息 id 查任务恒为 null。
    const msg = store.getMessage(id)
    if (!msg) throw new ServiceError(404, '任务不存在。')

    if (result.canceled) {
      return NextResponse.json({ ok: true, topic: store.getTopic(msg.topicId) })
    }

    // 终态（或已在 canceling）→ 直接回当前状态，绝不碰任务状态
    if (!isCancelableMessageStatus(msg.status)) {
      return NextResponse.json({ ok: true, topic: store.getTopic(msg.topicId), alreadySettled: true })
    }

    // 消息已开跑：标记 canceling，由 worker 在下一张出图前停止并按剩余退额
    store.syncTopicStatus(msg.topicId, id, msg.prompt, 'canceling')
    store.db.prepare(`UPDATE messages SET status = 'canceling' WHERE id = ? AND status = 'running'`).run(id)
    return NextResponse.json({ ok: true, topic: store.getTopic(msg.topicId) })
  } catch (e) {
    return jsonError(e)
  }
}
