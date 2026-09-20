import { NextRequest, NextResponse } from 'next/server'
import { isCanvasImagePlacement, normalizeCanvasMeta, type CanvasImagePlacement, type CanvasPatch } from '@motif/core'
import { getRuntime } from '@/server/context'
import { jsonError, readJson, requireUser } from '@/server/http'
import { assertOwnedTopic, ServiceError } from '@/server/services'

type Params = { params: Promise<{ id: string }> }

/** 校验一条 upsert。判据由 `@motif/core` 的 `isCanvasImagePlacement` 提供 —— 与画布文件
 * 导入（`lib/canvas/serialization.ts`）**共用同一份规则**，避免两处各自漂移。
 * 任一不合法即整批拒绝：绝不允许「部分写入」，否则客户端与服务端会永久分叉。 */
function assertPlacement(p: unknown): asserts p is CanvasImagePlacement {
  if (!isCanvasImagePlacement(p)) throw new ServiceError(400, '画布位置数据不合法。')
}

/** 画布快照：图片摆放 + 视口/背景。首次读取顺带补齐旧库（升级前无位置的老行） */
export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  try {
    const user = requireUser(req)
    const { id } = await params
    const store = getRuntime().store
    assertOwnedTopic(store, user.id, id)
    // 旧库补位：幂等，只对 updated_at 为空的老行生效
    store.backfillCanvasPlacements(id)
    return NextResponse.json({ images: store.listCanvasPlacements(id), meta: store.getCanvasMeta(id) })
  } catch (e) {
    return jsonError(e)
  }
}

/**
 * 画布增量补丁。返回 { applied, rejected, meta }：
 * - applied：真正写库的图片 id
 * - rejected：被图片级 LWW 拒绝（库中更新）或图已不存在的 id —— 客户端据此回滚
 * - meta：合并后的完整画布元信息，客户端直接采用
 *
 * ⚠️ 刻意不动 `topics.updated_at`（视口每拖动一次都会落库，撞 updated_at 会让 watchTopic
 * 长轮询把平移当成「任务有变化」而整份重取）。故这里用 setCanvasMeta 而非 touchTopic。
 */
export async function PATCH(req: NextRequest, { params }: Params): Promise<NextResponse> {
  try {
    const user = requireUser(req)
    const { id } = await params
    const store = getRuntime().store
    assertOwnedTopic(store, user.id, id)

    const patch = await readJson<CanvasPatch>(req)
    // upsert 必须是数组：非数组（字符串/对象/数字）要回 400 而不是让 forEach 抛成 500
    const rawUpserts = patch?.images?.upsert
    if (rawUpserts !== undefined && !Array.isArray(rawUpserts)) {
      throw new ServiceError(400, '画布位置数据不合法。')
    }
    const upserts = rawUpserts ?? []
    // P1 的删除走既有 DELETE /api/canvas-images/[id]（含磁盘清理），补丁里不带删除。
    // 若真收到删除指令则显式报错，而不是静默丢弃（静默丢弃会让客户端以为已删）。
    if (patch?.images?.delete?.length) throw new ServiceError(400, '画布补丁暂不支持删除图片。')

    // 先整批校验，再落库 —— 保证「任一非法则零写入」
    upserts.forEach(assertPlacement)

    const { applied, rejected } = store.upsertCanvasPlacements(id, upserts)

    let meta = store.getCanvasMeta(id)
    if (patch?.meta) {
      meta = normalizeCanvasMeta({
        ...meta,
        ...patch.meta,
        viewport: { ...meta.viewport, ...patch.meta.viewport },
      })
      store.setCanvasMeta(id, meta)
    }

    return NextResponse.json({ applied, rejected, meta })
  } catch (e) {
    return jsonError(e)
  }
}
