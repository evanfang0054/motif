import { NextRequest, NextResponse } from 'next/server'
import { requireRoot, writeAudit } from '@/server/admin'
import { getRuntime, invalidateRuntime } from '@/server/context'
import { jsonError, readJson } from '@/server/http'
import { ServiceError } from '@/server/services'
import { configHealth, readSettingsView, writeSettings } from '@/server/settings'

/** 系统设置读取（root 独占）。密钥类键只回掩码与已设置标记，永不回明文。 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    requireRoot(req)
    const { store } = getRuntime()
    return NextResponse.json({
      items: readSettingsView(store, process.env),
      health: configHealth(store, process.env),
    })
  } catch (e) {
    return jsonError(e)
  }
}

/** 系统设置保存（root 独占）。只接受非危险区键 —— 危险区走 /danger 专用入口。 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const actor = requireRoot(req)
    const body = await readJson<{ updates?: Record<string, string> }>(req)
    const updates = body.updates && typeof body.updates === 'object' ? body.updates : {}
    const { store } = getRuntime()

    const result = writeSettings(store, updates, { danger: false })
    if (!result.ok) throw new ServiceError(400, result.error)

    // 审计只记「哪些键被改了」，绝不记值 —— 密钥变更的值一旦入审计就等于绕过了「只写不读」
    writeAudit({
      actorId: actor.id,
      action: 'settings.update',
      targetType: 'settings',
      detail: { keys: result.updated, danger: false },
    })
    if (result.runtimeAffected) invalidateRuntime()
    return NextResponse.json({ ok: true, updated: result.updated, runtimeReloaded: result.runtimeAffected })
  } catch (e) {
    return jsonError(e)
  }
}
