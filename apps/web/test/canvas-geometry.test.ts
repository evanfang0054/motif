import { describe, expect, it } from 'vitest'
import { deleteImageConfirmText } from '@/components/workspace/canvas-geometry'
import { boundsOf, hitTest, rectsIntersect, toWorld, visibleRects } from '@/lib/canvas/geometry'

describe('rectsIntersect（矩形相交）', () => {
  const r = { x: 0, y: 0, w: 10, h: 10 }
  it('相交 / 部分相交 / 包含为真', () => {
    expect(rectsIntersect(r, { x: 5, y: 5, w: 10, h: 10 })).toBe(true)
    expect(rectsIntersect(r, { x: -5, y: -5, w: 10, h: 10 })).toBe(true)
    expect(rectsIntersect(r, { x: 2, y: 2, w: 3, h: 3 })).toBe(true)
  })
  it('分离 / 仅贴边不算相交', () => {
    expect(rectsIntersect(r, { x: 10, y: 0, w: 5, h: 5 })).toBe(false)
    expect(rectsIntersect(r, { x: 20, y: 20, w: 5, h: 5 })).toBe(false)
  })
})

describe('toWorld（屏幕→世界坐标）', () => {
  it('平移与缩放换算正确', () => {
    expect(toWorld(100, 50, { x: 0, y: 0, scale: 1 })).toEqual({ x: 100, y: 50 })
    expect(toWorld(100, 50, { x: 40, y: 20, scale: 2 })).toEqual({ x: 30, y: 15 })
    expect(toWorld(100, 50, { x: -60, y: -25, scale: 0.5 })).toEqual({ x: 320, y: 150 })
  })
})

describe('hitTest（框选命中）', () => {
  it('只返回与选框相交的卡片 id', () => {
    const cards = [
      { id: 'a', rect: { x: 0, y: 0, w: 10, h: 10 } },
      { id: 'b', rect: { x: 20, y: 0, w: 10, h: 10 } },
      { id: 'c', rect: { x: 5, y: 5, w: 10, h: 10 } },
    ]
    expect(hitTest(cards, { x: 0, y: 0, w: 10, h: 10 })).toEqual(['a', 'c'])
    expect(hitTest(cards, { x: 100, y: 100, w: 1, h: 1 })).toEqual([])
  })
})

describe('deleteImageConfirmText（确认文案）', () => {
  it('文案包含张数', () => {
    expect(deleteImageConfirmText(1)).toContain('1 张')
    expect(deleteImageConfirmText(7)).toContain('7 张')
  })
})

describe('boundsOf（世界包围盒）', () => {
  it('空数组返回 null', () => {
    expect(boundsOf([])).toBeNull()
  })
  it('单矩形即自身；多矩形取并集', () => {
    expect(boundsOf([{ x: 10, y: 20, w: 30, h: 40 }])).toEqual({ x: 10, y: 20, w: 30, h: 40 })
    expect(boundsOf([{ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 5, w: 10, h: 20 }])).toEqual({ x: 0, y: 0, w: 30, h: 25 })
  })
})

describe('visibleRects（视口裁剪）', () => {
  it('只保留与可见矩形相交的（贴边不算）', () => {
    const rects = [
      { x: 0, y: 0, w: 10, h: 10 },
      { x: 100, y: 100, w: 10, h: 10 },
      { x: 10, y: 0, w: 10, h: 10 },
    ]
    expect(visibleRects(rects, { x: 0, y: 0, w: 10, h: 10 })).toEqual([{ x: 0, y: 0, w: 10, h: 10 }])
  })
})
