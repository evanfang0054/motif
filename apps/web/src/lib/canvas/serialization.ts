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
  /**
   * 画布图 id → **原始文件名**（可选）。
   *
   * 为什么需要它：归档 zip 里的图片条目名必须是**纯 ASCII** —— 否则 macOS 自带的 Info-ZIP `unzip`
   * 会以 `Illegal byte sequence` 失败（exit 50，一张都解不出来）。而原文件名正是中文，
   * 故把它挪到这里保存。导入端不看条目名（只按 id 匹配），条目名可以随便取；
   * 但**人**解压后要能认出哪张是哪张，这份映射就是那个出口。
   */
  names?: Record<string, string>
}

export function serializeCanvas(input: {
  topicId: string
  meta: CanvasMeta
  images: CanvasImagePlacement[]
  exportedAt: string
  names?: Record<string, string>
}): CanvasExportFile {
  // 导出端也校验：形状非法的入参必须抛错，不能 `{...p}` 把 null 洗成 `{}` 静默落进文件
  for (const p of input.images) {
    if (!isCanvasImagePlacement(p)) throw new Error('导出失败：存在形状非法的图片摆放。')
  }
  const names = input.names && Object.keys(input.names).length > 0 ? { ...input.names } : null
  return {
    app: 'motif',
    version: 1,
    exportedAt: input.exportedAt,
    topicId: input.topicId,
    meta: normalizeCanvasMeta(input.meta),
    images: input.images.map((p) => ({ ...p })),
    ...(names ? { names } : {}),
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
    // 可选字段：老归档没有它（当时条目名还带着原名），读成「无映射」即可，不因此让导入失败
    ...(isNameMap(o.names) ? { names: o.names } : {}),
  }
}

/** `names` 必须是**非空**的 id → 字符串映射；形状不对就当没有 —— 它是**附加信息**，不该让导入失败。
 * 「非空」这条与写端对称（`serializeCanvas` 也不写空映射），否则会出现「读出来是 `{}`、写回去又没了」。 */
function isNameMap(v: unknown): v is Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const entries = Object.entries(v as Record<string, unknown>)
  return entries.length > 0 && entries.every(([, x]) => typeof x === 'string')
}
