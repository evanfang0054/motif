import { NextRequest, NextResponse } from 'next/server'
import { getRuntime } from '@/server/context'
import { readJson, jsonError } from '@/server/http'
import { login } from '@/server/services'
import { createSessionResponse } from '@/server/session'

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const { email, password } = await readJson<{ email: string; password: string }>(req)
    const user = login(getRuntime().store, email ?? '', password ?? '')
    return createSessionResponse({ user }, user.id)
  } catch (e) {
    return jsonError(e)
  }
}
