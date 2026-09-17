import { NextRequest, NextResponse } from 'next/server'
import { unlinkSync } from 'node:fs'
import { getRuntime } from '@/server/context'
import { jsonError, requireUser } from '@/server/http'
import { ServiceError } from '@/server/services'
import { storagePathFor } from '@motif/db'

type Params = { params: Promise<{ id: string }> }

/** 读取图片二进制 */
export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  try {
    const user = requireUser(req)
    const { id } = await params
    const { store, dataDir } = getRuntime()
    const img = store.getCanvasImage(id)
    if (!img || img.userId !== user.id) throw new ServiceError(404, '图片不存在。')
    const abs = storagePathFor(dataDir, img.imageKey)
    const buf = await import('node:fs').then((fs) => fs.readFileSync(abs))
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
    const { store, dataDir } = getRuntime()
    const img = store.getCanvasImage(id)
    if (!img || img.userId !== user.id) throw new ServiceError(404, '图片不存在。')
    store.deleteCanvasImage(id)
    try {
      unlinkSync(storagePathFor(dataDir, img.imageKey))
    } catch {
      // 文件可能已被清理，忽略
    }
    return NextResponse.json({ ok: true })
  } catch (e) {
    return jsonError(e)
  }
}
