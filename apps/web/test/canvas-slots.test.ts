import { describe, expect, it } from 'vitest'
import { allocateSlots, displaySize, placementRect, rectToPlacement, viewportOrigin, SLOT_COLS, SLOT_STEP, SLOT_W } from '@/lib/canvas/placement'
import { rectsIntersect, visibleRects } from '@/lib/canvas/geometry'

describe('空位槽分配', () => {
  it('同一视口连续分配 N=12 个槽位，两两矩形不相交', () => {
    const occupied: Array<{ x: number; y: number; w: number; h: number }> = []
    const origin = { x: 0, y: 0 }
    for (let i = 0; i < 12; i += 1) {
      const [slot] = allocateSlots(occupied, [displaySize(1024, 768)], origin)
      occupied.push(slot)
    }
    expect(occupied).toHaveLength(12)
    for (let i = 0; i < occupied.length; i += 1) {
      for (let j = i + 1; j < occupied.length; j += 1) {
        expect(rectsIntersect(occupied[i], occupied[j])).toBe(false)
      }
    }
  })

  it('一次性分配 12 个也两两不相交', () => {
    const sizes = Array.from({ length: 12 }, () => displaySize(1024, 1024))
    const slots = allocateSlots([], sizes, { x: -100, y: 50 })
    expect(slots).toHaveLength(12)
    for (let i = 0; i < slots.length; i += 1) {
      for (let j = i + 1; j < slots.length; j += 1) expect(rectsIntersect(slots[i], slots[j])).toBe(false)
    }
  })

  it('跳过被占用的槽（拖到网格上的图不会被压住）', () => {
    const occupied = [{ x: 0, y: 0, w: SLOT_W, h: SLOT_W }]
    const [slot] = allocateSlots(occupied, [displaySize(1024, 1024)], { x: 0, y: 0 })
    expect(rectsIntersect(slot, occupied[0])).toBe(false)
    expect(slot.x).toBe(SLOT_STEP) // 第一个空位是第 2 列
  })

  it('按 4 列换行', () => {
    const slots = allocateSlots([], Array.from({ length: SLOT_COLS + 1 }, () => displaySize(1024, 1024)), { x: 0, y: 0 })
    expect(slots[SLOT_COLS].y).toBe(SLOT_STEP)
    expect(slots[SLOT_COLS].x).toBe(0)
  })

  it('单任务 100 张图：分配不重叠且可被视口裁剪（100 张不崩溃）', () => {
    const sizes = Array.from({ length: 100 }, () => displaySize(1024, 1024))
    const slots = allocateSlots([], sizes, { x: 0, y: 0 })
    expect(slots).toHaveLength(100)
    for (let i = 0; i < slots.length; i += 1) {
      for (let j = i + 1; j < slots.length; j += 1) expect(rectsIntersect(slots[i], slots[j])).toBe(false)
    }
    // 视口裁剪：只返回与可见矩形相交的（暂不虚拟化，但为将来留余地）
    const visible = visibleRects(slots, { x: 0, y: 0, w: 600, h: 600 })
    expect(visible.length).toBeGreaterThan(0)
    expect(visible.length).toBeLessThan(100)
  })

  it('被大片占用填满时退化到下方另起一行，仍不重叠', () => {
    const occupied = Array.from({ length: 400 }, (_, i) => ({
      x: (i % SLOT_COLS) * SLOT_STEP,
      y: Math.floor(i / SLOT_COLS) * SLOT_STEP,
      w: SLOT_W,
      h: SLOT_W,
    }))
    const [slot] = allocateSlots(occupied, [displaySize(1024, 1024)], { x: 0, y: 0 })
    expect(occupied.every((r) => !rectsIntersect(r, slot))).toBe(true)
  })
})

describe('显示尺寸', () => {
  it('宽高比与原图宽高比之差 ≤ 1%（不拉伸）', () => {
    for (const [w, h] of [[1024, 768], [768, 1024], [1024, 1024], [1920, 1080], [300, 1200]] as const) {
      const size = displaySize(w, h)
      const natural = w / h
      const shown = size.width / size.height
      expect(Math.abs(shown - natural) / natural).toBeLessThanOrEqual(0.01)
    }
  })

  it('不放大：原图小于槽位时保持原尺寸', () => {
    expect(displaySize(100, 50)).toEqual({ width: 100, height: 50 })
  })

  it('原图尺寸未知（上传参考图 width/height 为 0）时回退正方形槽位', () => {
    expect(displaySize(0, 0)).toEqual({ width: SLOT_W, height: SLOT_W })
    expect(displaySize(1024, 0)).toEqual({ width: SLOT_W, height: SLOT_W })
  })
})

describe('viewportOrigin / 摆放互转', () => {
  it('视口原点 = 屏幕左上角对应的世界坐标', () => {
    expect(viewportOrigin({ x: 0, y: 0, k: 1 })).toEqual({ x: 0, y: 0 })
    expect(viewportOrigin({ x: 100, y: -50, k: 2 })).toEqual({ x: -50, y: 25 })
  })
  it('placementRect ↔ rectToPlacement 互逆', () => {
    const p = { id: 'cimg_a', canvasX: 1, canvasY: 2, canvasWidth: 3, canvasHeight: 4, updatedAt: 't' }
    expect(rectToPlacement('cimg_a', placementRect(p), 't')).toEqual(p)
  })
})
