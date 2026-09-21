import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, writeAudit } from '@/server/admin'
import { getRuntime } from '@/server/context'
import { jsonError, readJson } from '@/server/http'
import { refreshPromptSources } from '@/server/prompts'

/**
 * 手动刷新提示词源（管理员）。不传 sourceId 则刷新全部。
 *
 * 这是失败源唯一的人工恢复路径 —— 自动重试有 5 分钟节奏，手动刷新绕过它。
 * 成败都写审计（与「测试发送」同范式）：失败恰是最需要留痕的场景。
 * 频控在 service 层（`refreshPromptSources` 内），与既有动作型接口一致。
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const actor = requireAdmin(req)
    const { sourceId } = await readJson<{ sourceId?: string }>(req)
    try {
      const r = await refreshPromptSources(getRuntime().store, sourceId)
      writeAudit({
        actorId: actor.id,
        action: 'prompts.refresh',
        targetType: 'settings',
        detail: { sourceId: sourceId ?? null, ok: true, total: r.summary.total, failureCount: r.summary.failureCount },
      })
      return NextResponse.json(r)
    } catch (e) {
      writeAudit({
        actorId: actor.id,
        action: 'prompts.refresh',
        targetType: 'settings',
        detail: {
          sourceId: sourceId ?? null,
          ok: false,
          reason: e instanceof Error ? e.message.slice(0, 200) : 'unknown',
        },
      })
      throw e
    }
  } catch (e) {
    return jsonError(e)
  }
}
