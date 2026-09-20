/**
 * 画布 JSON 的序列化/反序列化（纯函数；导入导出 UI 留待后续）。
 *
 * 参考 `.infinite-canvas-ref/src/lib/canvas/canvas-export.ts` 与 `types/canvas-export.ts`
 * 的导出结构（app / version / exportedAt 三段式）。
 * 适配改动：**不含 zip** —— 上游用 fflate，而依赖白名单限定「仅新增 zustand ^5」，
 * 故本批只交付 JSON 序列化（导入导出 UI 留待后续）；解析端做结构校验，非法输入抛错而非
 * 静默返回空画布（避免「导入成功但画布空白」这种无声失败）。
 */
import { isCanvasImagePlacement, normalizeCanvasMeta, type CanvasImagePlacement, type CanvasMeta } from '@motif/core'

export interface CanvasExportFile {
  app: 'motif'
  version: 1
  exportedAt: string
  topicId: string
  meta: CanvasMeta
  images: CanvasImagePlacement[]
}

export function serializeCanvas(input: {
  topicId: string
  meta: CanvasMeta
  images: CanvasImagePlacement[]
  exportedAt: string
}): CanvasExportFile {
  // 导出端也校验：形状非法的入参必须抛错，不能 `{...p}` 把 null 洗成 `{}` 静默落进文件
  for (const p of input.images) {
    if (!isCanvasImagePlacement(p)) throw new Error('导出失败：存在形状非法的图片摆放。')
  }
  return {
    app: 'motif',
    version: 1,
    exportedAt: input.exportedAt,
    topicId: input.topicId,
    meta: normalizeCanvasMeta(input.meta),
    images: input.images.map((p) => ({ ...p })),
  }
}

export function parseCanvasExport(raw: string): CanvasExportFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('导入失败：文件不是合法 JSON。')
  }
  const o = parsed as Partial<CanvasExportFile> | null
  if (!o || typeof o !== 'object') throw new Error('导入失败：文件内容不是对象。')
  if (o.app !== 'motif') throw new Error('导入失败：不是 Motif 画布文件。')
  if (o.version !== 1) throw new Error(`导入失败：不支持的版本 ${String(o.version)}。`)
  if (typeof o.topicId !== 'string' || !o.topicId) throw new Error('导入失败：缺少任务 ID。')
  if (!Array.isArray(o.images)) throw new Error('导入失败：缺少图片列表。')
  // 逐条校验形状（与路由写入共用 `isCanvasImagePlacement`）—— 只查「是不是数组」会让
  // `[{}]` / `[null]` / `canvasX: "abc"` 一路带进画布，下游 TS 照样编译、运行时才炸
  for (const p of o.images) {
    if (!isCanvasImagePlacement(p)) throw new Error('导入失败：图片列表存在形状非法的条目。')
  }
  return {
    app: 'motif',
    version: 1,
    exportedAt: typeof o.exportedAt === 'string' ? o.exportedAt : '',
    topicId: o.topicId,
    meta: normalizeCanvasMeta(o.meta),
    images: o.images as CanvasImagePlacement[],
  }
}
