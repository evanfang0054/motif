import { NextRequest, NextResponse } from 'next/server'
import { getRuntime, resolveStorage } from '@/server/context'
import { jsonError, readJson, requireUser } from '@/server/http'
import { ServiceError } from '@/server/services'

/** 批量删除画布图片：任一 id 不存在或不属于当前用户即整批 404；校验通过后删行并逐个 best-effort 清理存储文件 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const user = requireUser(req)
    const { ids } = await readJson<{ ids?: string[] }>(req)
    const list = (ids ?? []).filter((x) => typeof x === 'string' && x.length > 0)
    if (list.length === 0) throw new ServiceError(400, '未选择要删除的图片。')
    const { store } = getRuntime()
    const owned = list.map((id) => {
      const img = store.getCanvasImage(id)
      if (!img || img.userId !== user.id) throw new ServiceError(404, '图片不存在。')
      return img
    })
    store.deleteCanvasImages(owned.map((img) => img.id))
    // 逐个 best-effort 清理：单个失败不阻塞整批（行已删除，文件残留不影响功能）
    const storage = resolveStorage()
    for (const img of owned) {
      try {
        await storage.remove(img.imageKey)
      } catch {
        // 对象可能已被清理或远端暂时不可达，忽略
      }
    }
    return NextResponse.json({ ok: true, deleted: owned.length })
  } catch (e) {
    return jsonError(e)
  }
}
