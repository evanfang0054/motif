/**
 * 图片直链：把返回给前端的 `src` 从「应用代理」换成对象存储 / CDN 的公开前缀（issue #57）。
 *
 * 为什么放在**应用侧**、而不是 `packages/db` 的 `rowToCanvasImage`：db 是纯存储层，读配置会让它
 * 依赖 settings。而「带 `src` 的图片对象进入 HTTP 响应」全仓只有一处（`GET /api/topics/[id]`），
 * 在那里做一次后处理就够 —— 客户端所有 `img.src`（画布 `<img>`、单图下载、zip 打包）都源自它。
 *
 * ⚠️ **未配 `S3_PUBLIC_BASE_URL` 时原样返回同一个数组**：升级无感，行为与本改动之前逐字一致。
 * 配了之后由对象存储直接供图（字节不再经应用进程），代价是**桶必须允许公开读** ——
 * key 含 userId/topicId + 随机串，不算可猜但也不是秘密，所以由部署者显式开启这个开关。
 */

/** 只做「去空白 + 去尾部斜杠」；空串/纯空白/undefined 一律视为未配 */
export function normalizePublicBase(base: string | null | undefined): string | null {
  const prefix = (base ?? '').trim().replace(/\/+$/, '')
  return prefix || null
}

/**
 * 把 `src` 重写为 `${base}/${imageKey}`。
 *
 * `imageKey` 形如 `<userId>/<topicId>/<uuid>.png`，**分隔符就是 `/` 且各段只含
 * 字母数字与 `-`/`_`**，所以直接拼、不做 URL 编码（编码会把 `/` 变成 `%2F` 从而打不开对象）。
 */
export function withPublicImageBase<T extends { src: string; imageKey: string }>(
  images: T[],
  base: string | null | undefined
): T[] {
  const prefix = normalizePublicBase(base)
  if (!prefix) return images
  return images.map((img) => ({ ...img, src: `${prefix}/${img.imageKey}` }))
}
