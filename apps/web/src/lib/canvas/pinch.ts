/**
 * 双指手势（pinch 缩放 + 双指平移）的纯函数状态机。
 *
 * 阈值与「先平移后切缩放」的迟滞照抄 tldraw 的思路（只抄思路不抄代码，本仓不引依赖）：
 *   packages/editor/src/lib/hooks/useGestureEvents.ts、.../managers/InputsManager/InputsManager.ts
 *
 * 为什么从 `base`（手势起始视口）重算而不是累加增量：pinch 的输入（两指的绝对坐标）
 * 本身就是绝对量 ⇒ 重算**无累积漂移**，且「连续 N 次 update == 一次到位」是可断言的纯函数性质。
 * 对照：平移路径（CanvasStage 的 pendingPanRef）是增量式，因为那里只有位移增量可用。
 *
 * ⚠️ 任何公式都不得拿 0/NaN 当分母 —— 与 viewport.ts 的 baseScale 同一约定
 * （两指重合在真机上是常见的抖动，产出 NaN 坐标会让画布整层消失）。
 */
import { panBy, zoomAt, type Viewport } from './viewport'

export interface PinchPoint {
  x: number
  y: number
}
export type PinchMode = 'undecided' | 'zoom' | 'pan'

export interface PinchState {
  mode: PinchMode
  /** 手势起始视口：所有产出都从它重算 */
  base: Viewport
  /** 归一后的起始指距（≥1） */
  startDist: number
  startMidX: number
  startMidY: number
}

/** 指距变化超过它 → 判为缩放 */
export const PINCH_ZOOM_THRESHOLD = 24
/** 中点位移超过它 → 判为平移 */
export const PINCH_PAN_THRESHOLD = 16
/** 已在平移时，指距变化要超过它才切缩放（迟滞，防抖） */
export const PINCH_PAN_TO_ZOOM = 64

const dist = (a: PinchPoint, b: PinchPoint) => Math.hypot(b.x - a.x, b.y - a.y)
const midX = (a: PinchPoint, b: PinchPoint) => (a.x + b.x) / 2
const midY = (a: PinchPoint, b: PinchPoint) => (a.y + b.y) / 2

export function pinchBegin(a: PinchPoint, b: PinchPoint, base: Viewport): PinchState {
  return {
    mode: 'undecided',
    base,
    startDist: Math.max(1, dist(a, b)),
    startMidX: midX(a, b),
    startMidY: midY(a, b),
  }
}

/**
 * 推进一帧。`viewport` 为 `null` 表示「还不动」（模式未定）。
 * ⚠️ 两指的**顺序无关**：只用指距与中点，故 Map 的插入序变化（抬指后再落指）不影响结果。
 */
export function pinchUpdate(
  s: PinchState,
  a: PinchPoint,
  b: PinchPoint,
): { state: PinchState; viewport: Viewport | null } {
  const d = dist(a, b)
  const mx = midX(a, b)
  const my = midY(a, b)
  const dDist = Math.abs(d - s.startDist)
  const dMid = Math.hypot(mx - s.startMidX, my - s.startMidY)

  let mode = s.mode
  if (mode === 'undecided') {
    if (dDist > PINCH_ZOOM_THRESHOLD) mode = 'zoom'
    else if (dMid > PINCH_PAN_THRESHOLD) mode = 'pan'
  } else if (mode === 'pan' && dDist > PINCH_PAN_TO_ZOOM) {
    mode = 'zoom'
  }

  const next: PinchState = { ...s, mode }
  if (mode === 'undecided') return { state: next, viewport: null }
  if (mode === 'pan') {
    return { state: next, viewport: panBy(s.base, mx - s.startMidX, my - s.startMidY) }
  }
  // zoom：**先按起始中点缩放，再按中点位移平移**（两步），不是「以当前中点为锚做一次 zoomAt」。
  // ⚠️ 为什么必须拆两步：以当前中点为锚时 `zoomAt(base, f, 当前中点)` 在 f === 1 处恒等于 base
  //    （real = k/from = 1 ⇒ 中点平移被完全抵消）⇒「捏开再把指距挪回原值」会让累积的平移全部丢失，
  //    手势**弹回**。拆两步后：f === 1 ⇒ 逐字段等于 panBy（单测钉住）；中点不动 ⇒ 纯以起始中点缩放。
  // clampScale（0.25–3）已在 zoomAt 内生效。
  const scaled = zoomAt(s.base, d / s.startDist, s.startMidX, s.startMidY)
  return { state: next, viewport: panBy(scaled, mx - s.startMidX, my - s.startMidY) }
}
