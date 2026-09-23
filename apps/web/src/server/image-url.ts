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
 * 算「这次请求该不该用直链」。
 *
 * ⚠️ **必须按驱动门控**：`local` 驱动下图片从来没进过桶，配了前缀也拼不出能取到的 URL ——
 * 那会把整页画布变成破图。而 `S3_*` 在驱动不是 s3 时**在管理后台是隐藏的**（保存不进去），
 * 所以「误配了就自己去后台清掉」这条路也不通。这里直接让它在非 s3 驱动下失效，
 * 既防破图，也不需要在后台为它开例外。
 *
 * 另：s3 驱动下**尚未搬迁**的老图只在本地，直链同样取不到 —— 那属于部署顺序问题，
 * 已在 README 写明「先跑完 storage:migrate 再配这个前缀」。
 */
export function publicImageBaseFor(driver: string | null | undefined, base: string | null | undefined): string | null {
  if ((driver ?? 'local').toLowerCase() !== 's3') return null
  return normalizePublicBase(base)
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
