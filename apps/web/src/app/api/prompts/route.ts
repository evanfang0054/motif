import { NextRequest, NextResponse } from 'next/server'
import { getRuntime } from '@/server/context'
import { jsonError, requireUser } from '@/server/http'
import { loadPromptLibrary, parsePromptQuery } from '@/server/prompts'

/**
 * 提示词库检索（登录必需）。
 *
 * 本接口**不等待外网**：陈旧源在后台抓，这里立刻返回库里已有的内容。
 * 库里还没有内容时返回 `pending: true`，前端据此显示加载态并轮询。
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    requireUser(req)
    const query = parsePromptQuery(req.nextUrl.searchParams)
    return NextResponse.json(await loadPromptLibrary(getRuntime().store, query))
  } catch (e) {
    return jsonError(e)
  }
}
