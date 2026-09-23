import { NextRequest, NextResponse } from 'next/server'
import { getRuntime, removeFromAllStorages, resolveReadStorages } from '@/server/context'
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
    // 双读：本地优先，本地没有读远端（切到 s3 后老图仍可读）。
    // ⚠️ 必须用 resolveReadStorages —— 「本地」永远指本地目录，不能拿 resolveStorage()
    // （s3 驱动下它返回远端，会把双读两侧变成同一个远端，本地老图直接 404）。
    const { local, remote } = resolveReadStorages()
    const buf = await readImageWithFallback(local, remote, img.imageKey)
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
    // 两侧都清（#58）：双读下同一个 key 可能本地与远端各有一份，只删一份会留下残留，
    // 且残留的远端对象会被下次 storage:migrate 当成「缺失」重新上传。
    await removeFromAllStorages(img.imageKey)
    return NextResponse.json({ ok: true })
  } catch (e) {
    return jsonError(e)
  }
}
