/**
 * 分页的纯数学部分（与组件分开，便于单测覆盖边界）。
 * 列表页与服务端共用同一套口径：`total` 是全量条数，`page` 从 1 开始。
 */

/** 总页数。0 条时也算 1 页（空态是「第 1 页没有数据」，不是「没有页」） */
export function pageCount(total: number, pageSize: number): number {
  if (!Number.isFinite(total) || total <= 0) return 1
  if (!Number.isFinite(pageSize) || pageSize < 1) return 1
  return Math.max(1, Math.ceil(total / pageSize))
}

/** 把页码夹到合法区间。数据变少（例如筛选后）时把越界的页码拉回来，避免停在空白页 */
export function clampPage(page: number, total: number, pageSize: number): number {
  const last = pageCount(total, pageSize)
  if (!Number.isFinite(page) || page < 1) return 1
  return Math.min(Math.floor(page), last)
}

/** 服务端分页用的 offset */
export function offsetFor(page: number, pageSize: number): number {
  const p = Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1
  return (p - 1) * pageSize
}
