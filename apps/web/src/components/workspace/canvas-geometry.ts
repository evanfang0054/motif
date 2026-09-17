/**
 * 画布几何纯函数：矩形相交、屏幕↔世界坐标换算、框选命中、确认文案。
 * 无 React 依赖，可独立单测（apps/web/test/canvas-geometry.test.ts）。
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

/** 批量删除确认文案 */
export function deleteImageConfirmText(n: number): string {
  return `将永久删除所选的 ${n} 张图片及其存储文件，删除后无法恢复。`
}
