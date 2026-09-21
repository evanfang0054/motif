import { NextRequest, NextResponse } from 'next/server'
import { getRuntime } from '@/server/context'
import { jsonError, requireUser } from '@/server/http'
import { parsePromptQuery, retryPromptLibrary } from '@/server/prompts'

/**
 * 用户侧「重试」：抓取失败时让用户自己重来一次，而不是只能等。
 *
 * 与惰性路径的区别：这里**绕过失败重试节奏**（否则点下去 5 分钟内什么都不会发生），
 * 因此按用户频控、只抓「失败或陈旧」的源。
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const user = requireUser(req)
    const query = parsePromptQuery(req.nextUrl.searchParams)
    return NextResponse.json(await retryPromptLibrary(getRuntime().store, query, user.id))
  } catch (e) {
    return jsonError(e)
  }
}
