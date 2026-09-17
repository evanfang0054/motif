import { describe, expect, it } from 'vitest'
import { deleteImageConfirmText, hitTest, rectsIntersect, toWorld } from '@/components/workspace/canvas-geometry'

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
