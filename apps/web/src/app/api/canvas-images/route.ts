import { NextRequest, NextResponse } from 'next/server'
import { detectImageMime } from '@motif/core'
import { getRuntime } from '@/server/context'
import { jsonError, requireUser } from '@/server/http'
import { ServiceError, saveReferenceImage } from '@/server/services'

/** 上传参考图（multipart form: topicId + file）。魔数校验，不信任客户端 Content-Type */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const user = requireUser(req)
    const form = await req.formData()
    const topicId = String(form.get('topicId') ?? '')
    const file = form.get('file')
    if (!topicId) throw new ServiceError(400, '缺少任务 ID。')
    if (!(file instanceof File)) throw new ServiceError(400, '请选择要上传的图片。')
    if (file.size > 10 * 1024 * 1024) throw new ServiceError(413, '图片不能超过 10MB。')
    const buffer = Buffer.from(await file.arrayBuffer())
    const mime = detectImageMime(buffer)
    if (!mime) throw new ServiceError(415, '仅支持 PNG / JPG / WebP。')
    const img = saveReferenceImage(getRuntime().store, getRuntime().dataDir, user, topicId, { buffer, mimeType: mime })
    return NextResponse.json({ canvasImage: img }, { status: 201 })
  } catch (e) {
    return jsonError(e)
  }
}
