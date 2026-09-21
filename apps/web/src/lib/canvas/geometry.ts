/**
 * 画布几何内核：矩形相交、屏幕↔世界坐标换算、框选命中、包围盒、视口裁剪。
 * 无 React 依赖，可独立单测（apps/web/test/canvas-geometry.test.ts）。
 *
 * 参考 `.infinite-canvas-ref/src/lib/canvas/canvas-node-geometry.ts`（nodeBounds 的归约写法）。
 * 适配改动：上游的 node 结构（position/width/height）换成统一的 Rect（x/y/w/h）；
 * 上游的分组/连线几何（findGroupDropTarget 等）不照抄 —— 我们只有图片节点、线是只读血缘。
 */

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

interface ViewLike {
  x: number
  y: number
  scale: number
}

/** 矩形相交（贴边不算）：a 与 b 有正面积重叠 */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/** 屏幕（容器内相对）坐标 → 画布世界坐标 */
export function toWorld(px: number, py: number, view: ViewLike): { x: number; y: number } {
  return { x: (px - view.x) / view.scale, y: (py - view.y) / view.scale }
}

/** 框选命中：返回与选框相交的卡片 id（保持入参顺序） */
export function hitTest(cards: Array<{ id: string; rect: Rect }>, rect: Rect): string[] {
  return cards.filter((c) => rectsIntersect(c.rect, rect)).map((c) => c.id)
}

/** 世界包围盒（空数组返回 null）—— 照抄上游 nodeBounds 的归约写法 */
export function boundsOf(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const r of rects) {
    minX = Math.min(minX, r.x)
    minY = Math.min(minY, r.y)
    maxX = Math.max(maxX, r.x + r.w)
    maxY = Math.max(maxY, r.y + r.h)
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/** 视口裁剪：只保留与可见矩形相交的卡片（暂不虚拟化，此处为将来留余地） */
export function visibleRects(rects: Rect[], viewportRect: Rect): Rect[] {
  return rects.filter((r) => rectsIntersect(r, viewportRect))
}
