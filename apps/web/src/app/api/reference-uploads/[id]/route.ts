import { NextRequest, NextResponse } from 'next/server'
import { existsSync, readFileSync } from 'node:fs'
import { storagePathFor } from '@motif/db'
import { getRuntime } from '@/server/context'
import { jsonError, requireUser } from '@/server/http'
import { ServiceError } from '@/server/services'

type Params = { params: Promise<{ id: string }> }

/**
 * 读取暂存参考图的二进制（`refu_`）。
 *
 * 为什么需要它：暂存参考此前只有「本地上传」一条来源，预览直接用 `URL.createObjectURL(file)`
 * 就够了；现在提示词库的示例图也会落成暂存参考，而它的来源是**第三方图床的 URL** ——
 * 若预览继续复用那个远程 URL，既破了「浏览器只跟本站说话」的边界，也会在对方防盗链或
 * 签名过期时变成破图（而我们明明已经把字节存在自己盘上了）。
 *
 * 归属校验走 topic（`StagedReference` 本身不带 userId）：与 `saveReferenceImage` 同一条判据。
 */
export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  try {
    const user = requireUser(req)
    const { id } = await params
    const { store, dataDir } = getRuntime()
    const ref = store.getReferenceUpload(id)
    const topic = ref ? store.getTopic(ref.topicId) : null
    if (!ref || !topic || topic.userId !== user.id) throw new ServiceError(404, '参考图不存在。')
    const abs = storagePathFor(dataDir, ref.imageKey)
    if (!existsSync(abs)) throw new ServiceError(404, '参考图文件不存在。')
    return new NextResponse(new Uint8Array(readFileSync(abs)), {
      headers: {
        'Content-Type': ref.mimeType,
        'Cache-Control': 'private, max-age=31536000',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch (e) {
    return jsonError(e)
  }
}
