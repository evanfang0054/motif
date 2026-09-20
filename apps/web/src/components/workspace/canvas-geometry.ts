/**
 * 画布文案助手。
 * 几何函数（Rect / rectsIntersect / toWorld / hitTest）已迁入 `@/lib/canvas/geometry`；
 * 本文件只保留 UI 文案，使 Workspace.tsx 的导入路径零改动。
 */

/** 批量删除确认文案 */
export function deleteImageConfirmText(n: number): string {
  return `将永久删除所选的 ${n} 张图片及其存储文件，删除后无法恢复。`
}
