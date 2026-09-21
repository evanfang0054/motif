import { NextRequest, NextResponse } from 'next/server'
import { getRuntime } from '@/server/context'
import { jsonError, readJson, requireUser } from '@/server/http'
import { ServiceError } from '@/server/services'
import { attachPromptImage } from '@/server/prompts'

/**
 * 把提示词库里某条提示词的示例图带进表单的参考图区（落成暂存参考 `refu_`，不进画布）。
 *
 * body 只给「哪条、第几张」——URL 由服务端从自己库里取，避免变成任意 URL 的抓取跳板。
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const user = requireUser(req)
    const body = await readJson<{ topicId?: string; sourceId?: string; entryId?: string; index?: number }>(req)
    const { topicId, sourceId, entryId, index } = body
    if (!topicId || !sourceId || !entryId || !Number.isInteger(index)) {
      throw new ServiceError(400, '请求参数不完整。')
    }
    const runtime = getRuntime()
    const result = await attachPromptImage(runtime.store, runtime.dataDir, user, {
      topicId,
      sourceId,
      entryId,
      index: index as number,
    })
    return NextResponse.json(result, { status: 201 })
  } catch (e) {
    return jsonError(e)
  }
}
