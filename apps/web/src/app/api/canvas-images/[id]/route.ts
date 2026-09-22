import { NextRequest, NextResponse } from 'next/server'
import { getRuntime, resolveRemoteStorage, resolveStorage } from '@/server/context'
import { jsonError, requireUser } from '@/server/http'
import { ServiceError } from '@/server/services'
import { readImageWithFallback } from '@/server/storage'

type Params = { params: Promise<{ id: string }> }

/** 读取图片二进制 */
export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  try {
    const user = requireUser(req)
    const { id } = await params
    const { store } = getRuntime()
    const img = store.getCanvasImage(id)
    if (!img || img.userId !== user.id) throw new ServiceError(404, '图片不存在。')
    // 双读：本地优先，本地没有读远端（切到 s3 后老图仍可读）
    const buf = await readImageWithFallback(resolveStorage(), resolveRemoteStorage(), img.imageKey)
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        'Content-Type': img.mimeType,
        'Cache-Control': 'private, max-age=31536000',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch (e) {
    return jsonError(e)
  }
}

export async function DELETE(req: NextRequest, { params }: Params): Promise<NextResponse> {
  try {
    const user = requireUser(req)
    const { id } = await params
    const { store } = getRuntime()
    const img = store.getCanvasImage(id)
    if (!img || img.userId !== user.id) throw new ServiceError(404, '图片不存在。')
    store.deleteCanvasImage(id)
    // 只删当前驱动下的对象：local 驱动删本地、s3 驱动删远端（不跨驱动误删）
    await resolveStorage().remove(img.imageKey)
    return NextResponse.json({ ok: true })
  } catch (e) {
    return jsonError(e)
  }
}
