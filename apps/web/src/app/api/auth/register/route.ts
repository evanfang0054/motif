import { NextRequest, NextResponse } from 'next/server'
import { getRuntime } from '@/server/context'
import { readJson, jsonError } from '@/server/http'
import { register } from '@/server/services'
import { createSessionResponse } from '@/server/session'

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body = await readJson<{
      name: string
      email: string
      code: string
      password: string
      passwordConfirm: string
      inviteCode?: string
    }>(req)
    const user = register(getRuntime().store, {
      name: body.name ?? '',
      email: body.email ?? '',
      code: body.code ?? '',
      password: body.password ?? '',
      passwordConfirm: body.passwordConfirm ?? '',
      inviteCode: body.inviteCode,
    })
    return createSessionResponse({ user }, user.id, 201)
  } catch (e) {
    return jsonError(e)
  }
}
