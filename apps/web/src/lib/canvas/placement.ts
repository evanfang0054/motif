/**
 * 空位槽与显示尺寸（客户端入口）。
 *
 * 参考 `.infinite-canvas-ref/src/lib/canvas/canvas-node-factory.ts`（createCanvasNode 的
 * 「以中心点定位」思路）与 `canvas-node-size.ts`（fitNodeSize 的等比缩放）。
 * 适配改动：上游按「节点中心点」定位且尺寸来自 node spec；Motif 只有图片节点，
 * 定位改为「视口左上角起、4 列网格找空位」，显示尺寸改为按原图比例钳制。
 *
 * ⚠️ 实现定义在 `@motif/core`：这组函数**服务端也要用**（`packages/db` 的旧库补位），
 * 而 packages/db 不能依赖 apps/web。本文件只做转出，让客户端 import 路径统一。
 */
export {
  SLOT_W,
  SLOT_GAP,
  SLOT_STEP,
  SLOT_COLS,
  allocateSlots,
  displaySize,
  placementRect,
  rectToPlacement,
  viewportOrigin,
  type CanvasRect,
} from '@motif/core'
