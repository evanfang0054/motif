import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/server/admin'
import { getRuntime } from '@/server/context'
import { jsonError } from '@/server/http'
import { ensurePromptSources, listPromptSourceStatuses } from '@/server/prompts'

/**
 * 提示词源状态（管理后台）。
 *
 * 先播种再读：源清单的真相在代码里，新库若直接读表会是空的，
 * 管理页就看不到那几个源（连「还没抓过」都显示不出来）。
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    requireAdmin(req)
    const store = getRuntime().store
    ensurePromptSources(store)
    return NextResponse.json({ sources: listPromptSourceStatuses(store) })
  } catch (e) {
    return jsonError(e)
  }
}
