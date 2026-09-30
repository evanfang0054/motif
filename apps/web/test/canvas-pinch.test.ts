import { describe, expect, it } from 'vitest'
import {
  PINCH_PAN_THRESHOLD,
  PINCH_PAN_TO_ZOOM,
  PINCH_ZOOM_THRESHOLD,
  pinchBegin,
  pinchUpdate,
  type PinchPoint,
} from '@/lib/canvas/pinch'
import { MAX_SCALE, MIN_SCALE, panBy, screenToWorld, type Viewport } from '@/lib/canvas/viewport'

const base: Viewport = { x: 0, y: 0, k: 1 }
const p = (x: number, y: number): PinchPoint => ({ x, y })
/** 以 (cx,cy) 为中点、指距 d 的一对指（水平方向） */
const pair = (cx: number, cy: number, d: number) => [p(cx - d / 2, cy), p(cx + d / 2, cy)] as const

describe('pinch 模式判定（阈值与迟滞）', () => {
  it('指距 +25 → zoom；+23 → 仍 undecided 且不动', () => {
    const [a, b] = pair(100, 100, 100 + PINCH_ZOOM_THRESHOLD + 1)
    expect(pinchUpdate(pinchBegin(...pair(100, 100, 100), base), a, b).state.mode).toBe('zoom')
    const [c, d] = pair(100, 100, 100 + PINCH_ZOOM_THRESHOLD - 1)
    const r = pinchUpdate(pinchBegin(...pair(100, 100, 100), base), c, d)
    expect(r.state.mode).toBe('undecided')
    expect(r.viewport).toBeNull()
  })

  it('中点 +17（指距不变）→ pan；+15 → 仍 undecided', () => {
    expect(
      pinchUpdate(pinchBegin(...pair(100, 100, 100), base), ...pair(100 + PINCH_PAN_THRESHOLD + 1, 100, 100)).state
        .mode,
    ).toBe('pan')
    expect(
      pinchUpdate(pinchBegin(...pair(100, 100, 100), base), ...pair(100 + PINCH_PAN_THRESHOLD - 1, 100, 100)).state
        .mode,
    ).toBe('undecided')
  })

  it('迟滞：pan 后指距 +40 不切、+70 才切 zoom', () => {
    let s = pinchBegin(...pair(100, 100, 100), base)
    s = pinchUpdate(s, ...pair(120, 100, 100)).state // → pan
    expect(s.mode).toBe('pan')
    s = pinchUpdate(s, ...pair(120, 100, 140)).state // 指距 +40
    expect(s.mode).toBe('pan')
    s = pinchUpdate(s, ...pair(120, 100, 100 + PINCH_PAN_TO_ZOOM + 10)).state
    expect(s.mode).toBe('zoom')
  })
})

describe('pinch 视口产出（无漂移 / 锚点 / panBy 等价）', () => {
  it('zoom：指距 ×2 ⇒ k 翻倍，且**起始中点**下的世界坐标不变', () => {
    const r = pinchUpdate(pinchBegin(...pair(200, 150, 100), base), ...pair(200, 150, 200))
    expect(r.viewport!.k).toBeCloseTo(2, 10)
    const before = screenToWorld(200, 150, base)
    const after = screenToWorld(200, 150, r.viewport!)
    expect(after.x).toBeCloseTo(before.x, 6)
    expect(after.y).toBeCloseTo(before.y, 6)
  })

  it('zoom：指距回到起始值、中点平移 ⇒ **逐字段等于 panBy**（防「手势弹回」）', () => {
    // 先进入 zoom 模式（一次指距变化），再把指距挪回起始值并平移中点
    const s1 = pinchUpdate(pinchBegin(...pair(200, 150, 100), base), ...pair(200, 150, 140)).state
    expect(s1.mode).toBe('zoom')
    const r = pinchUpdate(s1, ...pair(240, 150, 100))
    expect(r.state.mode).toBe('zoom')
    expect(r.viewport).toEqual(panBy(base, 40, 0))
  })

  it('pan：中点 +(30,0) ⇒ x += 30、k 不变', () => {
    const r = pinchUpdate(pinchBegin(...pair(200, 150, 100), base), ...pair(230, 150, 100))
    expect(r.state.mode).toBe('pan')
    expect(r.viewport).toEqual(panBy(base, 30, 0))
  })

  it('无漂移：连续 3 次 update 的结果 == 一次到位', () => {
    let cur = pinchBegin(...pair(200, 150, 100), base)
    for (const dx of [10, 20]) cur = pinchUpdate(cur, ...pair(200 + dx, 150, 100)).state
    const stepwise = pinchUpdate(cur, ...pair(230, 150, 100)).viewport
    const oneShot = pinchUpdate(pinchBegin(...pair(200, 150, 100), base), ...pair(230, 150, 100)).viewport
    expect(stepwise).toEqual(oneShot)
  })
})

describe('pinch 边界与退化', () => {
  it('两指重合（起始指距 0）不产 NaN/Infinity，k 落在钳制区间', () => {
    // ⚠️ 起始指距被 `Math.max(1, …)` 归一 ⇒「startDist === 0」永不出现；而同点输入下
    //    dDist = 1（≤24）、dMid = 0 ⇒ 模式仍是 undecided、viewport 为 null。
    //    所以只断言「viewport 有限」等于空转 —— 必须再**把两指拉开**，走一遍真实的产出路径。
    const s = pinchBegin(p(100, 100), p(100, 100), base)
    expect(Number.isFinite(s.startDist)).toBe(true)
    expect(pinchUpdate(s, p(100, 100), p(100, 100)).viewport).toBeNull() // 同点：还不动
    // 从重合状态拉开到指距 100（dDist = 99 > 24 ⇒ 进入 zoom），产出必须有限且被钳制
    const r = pinchUpdate(s, p(50, 100), p(150, 100))
    expect(r.state.mode).toBe('zoom')
    expect(r.viewport).not.toBeNull()
    expect(Number.isFinite(r.viewport!.x)).toBe(true)
    expect(Number.isFinite(r.viewport!.y)).toBe(true)
    expect(r.viewport!.k).toBeGreaterThanOrEqual(MIN_SCALE)
    expect(r.viewport!.k).toBeLessThanOrEqual(MAX_SCALE)
  })

  it('指距 ×100 ⇒ k === MAX_SCALE 且坐标有限', () => {
    const r = pinchUpdate(pinchBegin(...pair(200, 150, 10), base), ...pair(200, 150, 1000))
    expect(r.viewport!.k).toBe(MAX_SCALE)
    expect(Number.isFinite(r.viewport!.x)).toBe(true)
    expect(Number.isFinite(r.viewport!.y)).toBe(true)
  })
})
