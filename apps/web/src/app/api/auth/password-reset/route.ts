import { NextRequest, NextResponse } from 'next/server'
import { getRuntime } from '@/server/context'
import { readJson, jsonError } from '@/server/http'
import { resetPassword } from '@/server/services'

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body = await readJson<{ email: string; code: string; password: string }>(req)
    resetPassword(getRuntime().store, {
      email: body.email ?? '',
      code: body.code ?? '',
      password: body.password ?? '',
    })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return jsonError(e)
  }
}
