import { NextRequest, NextResponse } from 'next/server'
import { requireRoot } from '@/server/admin'
import { jsonError } from '@/server/http'

/**
 * 系统设置端点（root 独占）。地基阶段只做鉴权探针，
 * 真正的设置读写（DB 驱动 + 热重载）在 Plan 4 接入。
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const actor = requireRoot(req)
    return NextResponse.json({ ok: true, role: actor.role, writable: [] })
  } catch (e) {
    return jsonError(e)
  }
}
