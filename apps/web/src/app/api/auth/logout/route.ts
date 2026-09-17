import { NextRequest, NextResponse } from 'next/server'
import { jsonError } from '@/server/http'
import { createLogoutResponse } from '@/server/session'

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    return createLogoutResponse(req)
  } catch (e) {
    return jsonError(e)
  }
}
