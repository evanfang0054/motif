import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/server/admin'
import { getRuntime } from '@/server/context'
import { jsonError } from '@/server/http'

/**
 * 概览看板指标（admin 级）。六组数字全部来自 `MotifStore.overviewStats()`：
 * 额度类指标一律从 `credit_ledger` 聚合，因此可逐项对账，不存在估算口径。
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    requireAdmin(req)
    return NextResponse.json(getRuntime().store.overviewStats())
  } catch (e) {
    return jsonError(e)
  }
}
