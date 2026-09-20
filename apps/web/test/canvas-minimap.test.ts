import { describe, expect, it } from 'vitest'
import {
  EMPTY_WORLD_BOUNDS,
  MINIMAP_H,
  MINIMAP_MIN_RECT,
  MINIMAP_PAD,
  MINIMAP_W,
  fitMinimap,
  jumpViewport,
  toMinimap,
  toWorld,
  viewportRectIn,
  worldBoundsOf,
} from '@/lib/canvas/minimap'
import { worldToScreen } from '@/lib/canvas/viewport'

const SIZE = { w: 1000, h: 600 }

describe('小地图：包围盒', () => {
  it('空集合回退 1000×1000 的居中兜底盒', () => {
    expect(worldBoundsOf([])).toEqual(EMPTY_WORLD_BOUNDS)
  })

  it('四边各外扩 MINIMAP_PAD', () => {
    const b = worldBoundsOf([{ x: 100, y: 200, w: 240, h: 240 }])
    expect(b).toEqual({
      x: 100 - MINIMAP_PAD,
      y: 200 - MINIMAP_PAD,
      w: 240 + MINIMAP_PAD * 2,
      h: 240 + MINIMAP_PAD * 2,
    })
  })

  it('多矩形取并集（含 w/h 而不只是左上角）', () => {
    const b = worldBoundsOf([
      { x: 0, y: 0, w: 240, h: 240 },
      { x: 560, y: 300, w: 100, h: 400 },
    ])
    // 右上角应取第二张的 x+w 与 y+h
    expect(b.x + b.w).toBe(660 + MINIMAP_PAD)
    expect(b.y + b.h).toBe(700 + MINIMAP_PAD)
  })
})

describe('小地图：缩略比例（contain 适配）', () => {
  it('宽扁包围盒受宽度约束', () => {
    const fit = fitMinimap({ x: 0, y: 0, w: 2000, h: 200 })
    expect(fit.scale).toBeCloseTo(MINIMAP_W / 2000, 9)
  })

  it('高瘦包围盒受高度约束', () => {
    const fit = fitMinimap({ x: 0, y: 0, w: 200, h: 2000 })
    expect(fit.scale).toBeCloseTo(MINIMAP_H / 2000, 9)
  })

  it('居中偏移：等比塞入后左右/上下留白相等', () => {
    const bounds = { x: 0, y: 0, w: 2000, h: 200 }
    const fit = fitMinimap(bounds)
    expect(fit.offsetX).toBeCloseTo(0, 9) // 宽度已占满
    expect(fit.offsetY).toBeCloseTo((MINIMAP_H - 200 * fit.scale) / 2, 9)
  })

  it('退化的 0 宽高不产出 NaN/Infinity', () => {
    const fit = fitMinimap({ x: 0, y: 0, w: 0, h: 0 })
    expect(Number.isFinite(fit.scale)).toBe(true)
    expect(Number.isFinite(fit.offsetX)).toBe(true)
  })
})

describe('小地图：坐标映射互为逆', () => {
  it('toWorld(toMinimap(p)) === p', () => {
    const bounds = worldBoundsOf([{ x: 120, y: 80, w: 240, h: 240 }])
    const fit = fitMinimap(bounds)
    for (const p of [
      { x: 0, y: 0 },
      { x: 120, y: 80 },
      { x: -300, y: 900 },
    ]) {
      const back = toWorld(toMinimap(p, bounds, fit), bounds, fit)
      expect(back.x).toBeCloseTo(p.x, 9)
      expect(back.y).toBeCloseTo(p.y, 9)
    }
  })
})

describe('小地图：视口矩形', () => {
  it('k 变大时视口矩形收缩（同一容器看到的范围变小）', () => {
    const bounds = worldBoundsOf([{ x: 0, y: 0, w: 240, h: 240 }])
    const fit = fitMinimap(bounds)
    const at1 = viewportRectIn({ x: 0, y: 0, k: 1 }, SIZE, bounds, fit)
    const at2 = viewportRectIn({ x: 0, y: 0, k: 2 }, SIZE, bounds, fit)
    expect(at2.w).toBeLessThan(at1.w)
    expect(at2.h).toBeLessThan(at1.h)
  })

  it('宽高有 4px 下限（极小时仍可点）', () => {
    const bounds = worldBoundsOf([{ x: 0, y: 0, w: 240, h: 240 }])
    const fit = fitMinimap(bounds)
    const tiny = viewportRectIn({ x: 0, y: 0, k: 100 }, { w: 10, h: 10 }, bounds, fit)
    expect(tiny.w).toBeGreaterThanOrEqual(MINIMAP_MIN_RECT)
    expect(tiny.h).toBeGreaterThanOrEqual(MINIMAP_MIN_RECT)
  })

  it('k 为 0/NaN 时不产出 NaN', () => {
    const bounds = EMPTY_WORLD_BOUNDS
    const fit = fitMinimap(bounds)
    for (const k of [0, Number.NaN]) {
      const r = viewportRectIn({ x: 0, y: 0, k }, SIZE, bounds, fit)
      expect(Number.isFinite(r.x)).toBe(true)
      expect(Number.isFinite(r.y)).toBe(true)
      expect(Number.isFinite(r.w)).toBe(true)
      expect(Number.isFinite(r.h)).toBe(true)
    }
  })
})

describe('小地图：点击跳转', () => {
  it('目标世界点被顶到视口中心，且缩放比例不变', () => {
    const target = { x: 640, y: 480 }
    const before = { x: 33, y: -17, k: 1.5 }
    const after = jumpViewport(target, before, SIZE)
    expect(after.k).toBe(before.k)
    const screen = worldToScreen(target.x, target.y, after)
    expect(screen.x).toBeCloseTo(SIZE.w / 2, 9)
    expect(screen.y).toBeCloseTo(SIZE.h / 2, 9)
  })
})
