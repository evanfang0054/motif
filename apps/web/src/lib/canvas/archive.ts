/**
 * 画布归档（导出/导入的 zip 编排，纯逻辑，UI 只负责取字节与触发下载）。
 *
 * 语义边界（与 UI 文案必须一致）：
 * - **导出 = 布局 + 图片副本**：`canvas.json`（复用 `serialization.serializeCanvas`）+ 每张图的字节条目；
 * - **导入只恢复布局**（摆放 + 视口 + 图案），**不会新建画布图** —— 服务端 `upsertCanvasPlacements` 是
 *   UPDATE-only，归档里 id 在当前任务不存在时必然被拒，只能如实计入 `skipped`。
 *
 * 参考 `.infinite-canvas-ref/src/lib/canvas/canvas-export.ts`（zip 内 `projects.json` + 资源目录的布局思路），
 * 但**不照抄其「无校验、静默跳过」的导入策略** —— 这里复用 `parseCanvasExport` 的严格校验。
 */
import type { CanvasImagePlacement, CanvasMeta } from '@motif/core'
import { parseCanvasExport, serializeCanvas, type CanvasExportFile } from './serialization'

/** 归档里画布 JSON 的固定条目名 */
export const CANVAS_JSON_ENTRY = 'canvas.json'

export interface ArchiveEntry {
  name: string
  /** 图片条目的取字节地址（`canvas.json` 用 `text`） */
  src?: string
  /** 内联文本（只有 `canvas.json` 用） */
  text?: string
}

export interface ArchiveImage {
  id: string
  serial: number
  name: string
  src: string
  mimeType?: string
}

/** 常见图片 mime → 扩展名（画布图名不带扩展名，靠它给出可读后缀） */
const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
}

/**
 * 归档里图片条目的命名。
 *
 * ⚠️ **必须是纯 ASCII**（`files/<三位序号>[-<ASCII 原名>].<扩展名>`）。
 * 这不是审美取舍，是硬要求：条目名含非 ASCII 时，macOS 自带的 Info-ZIP `unzip` 会以
 * `Illegal byte sequence` 失败（exit 50，**一张都解不出来**）。注意 zip 本身是合规的 ——
 * UTF-8 标志位（general purpose bit 11）一直都在，Python / `ditto` / Finder 都能正确读出中文名，
 * 只有 Info-ZIP 6.00 这一支不行；故改为从**产物侧**回避，而不是继续指望解压端。
 *
 * 代价可控：导入端**从不读条目名**（只按 `canvas.json` 里的 id 匹配），故条目名对功能没有影响；
 * 「哪张是哪张」由 `canvas.json` 的 `names` 映射承担（见 `serializeCanvas`）。
 * 原名本身是 ASCII 时仍原样保留（`001-hero-shot.png`），读起来照样清楚。
 *
 * 对照：**批量下载**的 `zipEntryName` 仍用原名 —— 那里没有 `canvas.json` 兜底，
 * 文件名本身就是产物，去掉中文等于把信息删掉。
 */
export function archiveEntryName(img: { serial: number; name: string; src: string; mimeType?: string }): string {
  const raw = img.name || img.src.split('/').pop() || 'image'
  const dot = raw.lastIndexOf('.')
  const base = dot > 0 ? raw.slice(0, dot) : raw
  // 扩展名优先级：原名里带的 > mime 推的 > bin
  const fromName = dot > 0 ? raw.slice(dot + 1).replace(/[^a-zA-Z0-9]/g, '') : ''
  const fromMime = img.mimeType ? (MIME_EXT[img.mimeType.toLowerCase()] ?? '') : ''
  const ext = fromName || fromMime || 'bin'
  // 只保留**整段都是 ASCII** 的原名：含中文就整段去掉（留半截「-1」之类的残渣反而更难认）
  const asciiBase = /^[\x20-\x7e]+$/.test(base) ? base.replace(/[\\/:*?"<>|]/g, '_').trim() : ''
  const serial = String(img.serial).padStart(3, '0')
  return `files/${serial}${asciiBase ? `-${asciiBase}` : ''}.${ext}`
}

/**
 * 导出条目清单：第 1 条固定 `canvas.json`（内联文本），其余为图片字节地址。
 * 形状非法（`isCanvasImagePlacement` 不过）由 `serializeCanvas` 抛错，这里不吞。
 */
export function canvasArchiveEntries(input: {
  topicId: string
  meta: CanvasMeta
  images: CanvasImagePlacement[]
  archiveImages: ArchiveImage[]
  exportedAt: string
}): ArchiveEntry[] {
  const file = serializeCanvas({
    topicId: input.topicId,
    meta: input.meta,
    images: input.images,
    exportedAt: input.exportedAt,
    // 条目名已改为 ASCII，原名必须另存一份，否则解压后认不出哪张是哪张
    names: Object.fromEntries(input.archiveImages.map((img) => [img.id, img.name || img.src.split('/').pop() || ''])),
  })
  const entries: ArchiveEntry[] = [{ name: CANVAS_JSON_ENTRY, text: JSON.stringify(file, null, 2) }]
  for (const img of input.archiveImages) {
    entries.push({ name: archiveEntryName(img), src: img.src })
  }
  return entries
}

/** 解析归档里的 `canvas.json`：缺条目/内容非法都抛错（不静默返回空画布） */
export function parseCanvasArchive(files: Map<string, Uint8Array>): CanvasExportFile {
  const raw = files.get(CANVAS_JSON_ENTRY)
  if (!raw) throw new Error('导入失败：不是画布归档（缺少 canvas.json）。')
  return parseCanvasExport(new TextDecoder('utf-8').decode(raw))
}

/**
 * 把导入的摆放合并到当前画布：**只对当前已存在的 id 生效**，其余进 `skipped`。
 *
 * ⚠️ `updatedAt` 必须用**当前时间**重盖，不能沿用归档里的旧戳：服务端按 `updated_at` 做图片级 LWW
 * （`row.updated_at > p.updatedAt` 即拒），只要导出之后画布变过，旧戳就会被整批拒绝、导入看起来「没生效」。
 */
export function mergeImportedPlacements(
  current: readonly CanvasImagePlacement[],
  imported: readonly CanvasImagePlacement[],
  updatedAt: string
): { applied: CanvasImagePlacement[]; skipped: string[] } {
  const known = new Set(current.map((p) => p.id))
  const applied: CanvasImagePlacement[] = []
  const skipped: string[] = []
  for (const p of imported) {
    if (!known.has(p.id)) {
      skipped.push(p.id)
      continue
    }
    applied.push({ ...p, updatedAt })
  }
  return { applied, skipped }
}
