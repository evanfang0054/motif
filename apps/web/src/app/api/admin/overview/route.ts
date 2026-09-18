import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/server/admin'
import { jsonError } from '@/server/http'

/**
 * 概览看板端点（admin 级）。
 * 地基阶段只返回可用性与角色，指标计算在 Plan 3 接入。
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const actor = requireAdmin(req)
    return NextResponse.json({ ok: true, role: actor.role })
  } catch (e) {
    return jsonError(e)
  }
}
