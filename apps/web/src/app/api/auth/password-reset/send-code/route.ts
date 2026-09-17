import { NextRequest, NextResponse } from 'next/server'
import { getRuntime } from '@/server/context'
import { readJson, jsonError } from '@/server/http'
import { sendCode } from '@/server/services'
import { checkRate } from '@/server/rate-limit'

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const { email } = await readJson<{ email: string }>(req)
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local'
    if (!checkRate(`code:ip:${ip}`, 3_600_000, 30)) {
      return NextResponse.json({ error: '请求过于频繁，请稍后再试。' }, { status: 429 })
    }
    const result = await sendCode(getRuntime().store, getRuntime().mailer, 'password-reset', email ?? '')
    return NextResponse.json(result)
  } catch (e) {
    return jsonError(e)
  }
}
