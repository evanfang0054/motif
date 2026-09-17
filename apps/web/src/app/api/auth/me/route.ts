import { NextRequest, NextResponse } from 'next/server'
import { currentUser, requireUser, jsonError } from '@/server/http'
import { getRuntime } from '@/server/context'

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const user = currentUser(req)
    return NextResponse.json({ user })
  } catch (e) {
    return jsonError(e)
  }
}

/** 更新个人资料（昵称 / 头像） */
export async function PATCH(req: NextRequest): Promise<NextResponse> {
  try {
    const user = requireUser(req)
    const body = (await req.json()) as { name?: string; avatarUrl?: string | null }
    if (body.name !== undefined) {
      if (!body.name.trim()) return NextResponse.json({ error: '昵称不能为空。' }, { status: 400 })
      if (body.name.length > 40) return NextResponse.json({ error: '昵称过长。' }, { status: 400 })
    }
    if (body.avatarUrl) {
      // 仅允许 http(s) 图片地址或站内路径，长度 300 以内
      const ok = /^(https?:\/\/|\/)/.test(body.avatarUrl) && body.avatarUrl.length <= 300
      if (!ok) return NextResponse.json({ error: '头像地址不合法。' }, { status: 400 })
    }
    getRuntime().store.updateUserProfile(user.id, { name: body.name, avatarUrl: body.avatarUrl })
    return NextResponse.json({ user: getRuntime().store.getUserById(user.id) })
  } catch (e) {
    return jsonError(e)
  }
}
