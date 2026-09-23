import { NextRequest, NextResponse } from 'next/server'
import { getRuntime, removeManyFromAllStorages } from '@/server/context'
import { jsonError, readJson, requireUser } from '@/server/http'
import { assertOwnedTopic, ServiceError } from '@/server/services'
import { resolveSetting } from '@/server/settings'
import { publicImageBaseFor, withPublicImageBase } from '@/server/image-url'

type Params = { params: Promise<{ id: string }> }

export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  try {
    const user = requireUser(req)
    const { id } = await params
    const { store } = getRuntime()
    const detail = store.getTopicDetail(id)
    if (!detail || detail.topic.userId !== user.id) throw new ServiceError(404, '任务不存在。')
    // 附带暂存参考（上传后未生成的），供面板跨刷新恢复
    const staged = store.listReferenceUploads(id)
    // 配了 S3_PUBLIC_BASE_URL（且驱动确实是 s3）就把画布图片的 src 换成对象存储直链（#57）；
    // 否则原样返回。这里是**唯一**把带 src 的图片交给客户端的地方（其余接口都不含 src），故只需改这一处。
    const base = publicImageBaseFor(
      resolveSetting(store, process.env, 'STORAGE_DRIVER'),
      resolveSetting(store, process.env, 'S3_PUBLIC_BASE_URL')
    )
    const canvasImages = withPublicImageBase(detail.canvasImages, base)
    return NextResponse.json({ ...detail, canvasImages, staged })
  } catch (e) {
    return jsonError(e)
  }
}

/** 重命名任务 */
export async function PATCH(req: NextRequest, { params }: Params): Promise<NextResponse> {
  try {
    const user = requireUser(req)
    const { id } = await params
    assertOwnedTopic(getRuntime().store, user.id, id)
    const { title } = await readJson<{ title?: string }>(req)
    const t = (title ?? '').trim()
    if (!t) throw new ServiceError(400, '请输入任务名称。')
    const topic = getRuntime().store.renameTopic(id, t)
    return NextResponse.json({ topic })
  } catch (e) {
    return jsonError(e)
  }
}

export async function DELETE(req: NextRequest, { params }: Params): Promise<NextResponse> {
  try {
    const user = requireUser(req)
    const { id } = await params
    const { store, dataDir } = getRuntime()
    assertOwnedTopic(store, user.id, id)
    // ⚠️ 顺序：**先删行、再清对象**（#61）。行是真相 —— 行删掉了、对象没清干净只会留孤儿
    // （搬迁会报出来）；反过来则会出现「行指向已不存在的对象」＝画布上的破图。
    // deleteTopic 把画布图与暂存参考图的 key 一并给出；removeMany 内部有界并发（s3 下串行会超时），
    // 且逐项 best-effort 不抛。
    const keys = store.deleteTopic(id)
    await removeManyFromAllStorages(keys, dataDir)
    return NextResponse.json({ ok: true })
  } catch (e) {
    return jsonError(e)
  }
}
