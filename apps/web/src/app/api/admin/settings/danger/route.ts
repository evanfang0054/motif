import { NextRequest, NextResponse } from 'next/server'
import { requireRoot, writeAudit } from '@/server/admin'
import { getRuntime } from '@/server/context'
import { jsonError, readJson } from '@/server/http'
import { ServiceError } from '@/server/services'
import { writeSettings } from '@/server/settings'

/**
 * 危险区开关（root 独占）。
 *
 * 单独成一个端点、而不是在普通保存上加一个 confirm 布尔量 —— 因为「会削弱安全基线的开关」
 * 与「改个模型名」不该共用一条路径：共用意味着任何一个能提交普通配置的地方，
 * 只要顺手带上 confirm 就能关掉邮箱验证。这里物理上只接受危险区键。
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const actor = requireRoot(req)
    const body = await readJson<{ updates?: Record<string, string>; confirm?: unknown }>(req)
    // 必须是严格 true：0 / "true" / 1 都不算确认（避免「随手带个真值就过了」）
    if (body.confirm !== true) throw new ServiceError(400, '危险区开关需要显式二次确认。')

    const updates = body.updates && typeof body.updates === 'object' ? body.updates : {}
    const { store } = getRuntime()
    const result = writeSettings(store, updates, { danger: true })
    if (!result.ok) throw new ServiceError(400, result.error)

    writeAudit({
      actorId: actor.id,
      action: 'settings.update',
      targetType: 'settings',
      detail: { keys: result.updated, danger: true },
    })
    return NextResponse.json({ ok: true, updated: result.updated })
  } catch (e) {
    return jsonError(e)
  }
}
