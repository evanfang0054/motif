import { describe, expect, it } from 'vitest'
import { clampScale, fitView, panBy, screenToWorld, toolbarAnchor, worldToScreen, zoomAt, MAX_SCALE, MIN_SCALE } from '@/lib/canvas/viewport'
import { gridStyle } from '@/lib/canvas/grid'

describe('缩放锚点（L4-2-G2-A1）', () => {
  it('缩放后光标下的世界坐标不变', () => {
    const v = { x: 40, y: -20, k: 1 }
    const anchorX = 300
    const anchorY = 180
    const before = screenToWorld(anchorX, anchorY, v)
    const after = screenToWorld(anchorX, anchorY, zoomAt(v, 1.5, anchorX, anchorY))
    expect(after.x).toBeCloseTo(before.x, 9)
    expect(after.y).toBeCloseTo(before.y, 9)
  })
  it('连续多次缩放仍不漂移（20 次全部真实生效，不触顶）', () => {
    let v = { x: 0, y: 0, k: 1 }
    const anchorX = 123
    const anchorY = 456
    const before = screenToWorld(anchorX, anchorY, v)
    // 用 1.02 而非 1.1：1.02^20 ≈ 1.49 < MAX_SCALE(3)，20 步全都真的在缩放，
    // 不会像 1.1 那样在第 12 步就触顶、之后退化成恒等变换
    for (let i = 0; i < 20; i += 1) v = zoomAt(v, 1.02, anchorX, anchorY)
    expect(v.k).toBeGreaterThan(1.4)
    expect(v.k).toBeLessThan(3)
    const after = screenToWorld(anchorX, anchorY, v)
    expect(after.x).toBeCloseTo(before.x, 6)
    expect(after.y).toBeCloseTo(before.y, 6)
  })

  it('缩放先放大到顶再缩到 20 次，仍不漂移', () => {
    let v = { x: 10, y: -10, k: 1 }
    const anchorX = 77
    const anchorY = 33
    const before = screenToWorld(anchorX, anchorY, v)
    for (let i = 0; i < 20; i += 1) v = zoomAt(v, 1.1, anchorX, anchorY) // 会触顶
    for (let i = 0; i < 20; i += 1) v = zoomAt(v, 1 / 1.1, anchorX, anchorY) // 再缩回
    const after = screenToWorld(anchorX, anchorY, v)
    expect(after.x).toBeCloseTo(before.x, 6)
    expect(after.y).toBeCloseTo(before.y, 6)
  })
})

describe('视口必须是全函数（k 为 0/负数/NaN 时绝不产出 NaN —— 与 core 的 viewportOrigin 同一约定）', () => {
  it('zoomAt 在 k<=0 或 NaN 时仍返回有限值', () => {
    for (const k of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const v = zoomAt({ x: 5, y: 7, k }, 1.1, 100, 50)
      expect(Number.isFinite(v.k)).toBe(true)
      expect(Number.isFinite(v.x)).toBe(true)
      expect(Number.isFinite(v.y)).toBe(true)
    }
  })

  it('screenToWorld 在 k<=0 或 NaN 时仍返回有限值', () => {
    for (const k of [0, -1, Number.NaN]) {
      const w = screenToWorld(100, 50, { x: 5, y: 7, k })
      expect(Number.isFinite(w.x)).toBe(true)
      expect(Number.isFinite(w.y)).toBe(true)
    }
  })
})

describe('缩放钳制（L4-2-G2-A2）', () => {
  it('小于下限取下限、大于上限取上限', () => {
    expect(clampScale(0.01)).toBe(MIN_SCALE)
    expect(clampScale(99)).toBe(MAX_SCALE)
    expect(clampScale(1.5)).toBe(1.5)
    expect(MIN_SCALE).toBe(0.25)
    expect(MAX_SCALE).toBe(3)
  })
  it('zoomAt 的 k 始终在 [0.25, 3]', () => {
    expect(zoomAt({ x: 0, y: 0, k: 0.3 }, 0.1, 0, 0).k).toBe(MIN_SCALE)
    expect(zoomAt({ x: 0, y: 0, k: 2.9 }, 10, 0, 0).k).toBe(MAX_SCALE)
  })
})

describe('屏幕↔世界互转', () => {
  it('互逆', () => {
    const v = { x: 33, y: -77, k: 2.5 }
    const s = worldToScreen(120, 80, v)
    expect(screenToWorld(s.x, s.y, v)).toEqual({ x: 120, y: 80 })
  })
})

describe('panBy / fitView', () => {
  it('panBy 只改平移不改缩放', () => {
    expect(panBy({ x: 1, y: 2, k: 2 }, 10, -5)).toEqual({ x: 11, y: -3, k: 2 })
  })
  it('fitView 把包围盒放进视口并居中（含 padding）', () => {
    const v = fitView({ x: 0, y: 0, w: 1000, h: 1000 }, 500, 500, 50)
    // (500-100)/(1000) = 0.4
    expect(v.k).toBeCloseTo(0.4, 9)
    // 居中：世界中心 (500,500) 应落在视口中心 (250,250)
    expect(500 * v.k + v.x).toBeCloseTo(250, 6)
    expect(500 * v.k + v.y).toBeCloseTo(250, 6)
  })
  it('fitView 的 k 也被钳制', () => {
    expect(fitView({ x: 0, y: 0, w: 10, h: 10 }, 1000, 1000, 0).k).toBe(MAX_SCALE)
  })
})

describe('toolbarAnchor（浮动工具栏定位）', () => {
  it('空数组返回 null', () => {
    expect(toolbarAnchor([], { x: 0, y: 0, k: 1 })).toBeNull()
  })

  it('返回的键名必须是 left/top（写成 x/y 会被 React 当 SVG 属性，工具栏会跑到左上角）', () => {
    const a = toolbarAnchor([{ x: 0, y: 0, w: 240, h: 240 }], { x: 0, y: 0, k: 1 })!
    expect(Object.keys(a).sort()).toEqual(['left', 'top'])
    expect(a).not.toHaveProperty('x')
    expect(a).not.toHaveProperty('y')
  })

  it('单个矩形：锚在顶部居中并抬高 12', () => {
    expect(toolbarAnchor([{ x: 100, y: 50, w: 240, h: 240 }], { x: 0, y: 0, k: 1 })).toEqual({
      left: 220,
      top: 38,
    })
  })

  it('多个矩形：取包围盒的顶部居中（不是第一张）', () => {
    // 包围盒 x 100..580（中心 340），顶部 y=50 → top 38
    expect(
      toolbarAnchor(
        [
          { x: 100, y: 80, w: 240, h: 240 },
          { x: 340, y: 50, w: 240, h: 240 },
        ],
        { x: 0, y: 0, k: 1 }
      )
    ).toEqual({ left: 340, top: 38 })
  })

  it('随视口平移缩放换算（与 worldToScreen 一致）', () => {
    const v = { x: 40, y: -20, k: 2 }
    const a = toolbarAnchor([{ x: 100, y: 50, w: 240, h: 240 }], v)!
    expect(a.left).toBe(100 * 2 + 40 + 240) // 中心 x=220 → 220*2+40
    expect(a.top).toBe(50 * 2 - 20 - 12)
  })
})

describe('背景图案（L4-2-G1-A4、L1-1-G2-A4）', () => {
  it('blank 不渲染', () => {
    expect(gridStyle('blank', { x: 0, y: 0, k: 1 })).toBeNull()
  })
  it('网格间距 = 48 * k，随缩放变化', () => {
    expect(gridStyle('lines', { x: 0, y: 0, k: 1 })!.backgroundSize).toBe('48px 48px')
    expect(gridStyle('lines', { x: 0, y: 0, k: 2 })!.backgroundSize).toBe('96px 96px')
  })
  it('图案偏移 = viewport % gridSize，随平移变化', () => {
    expect(gridStyle('lines', { x: 10, y: -30, k: 1 })!.backgroundPosition).toBe('10px -30px')
    expect(gridStyle('lines', { x: 50, y: 20, k: 1 })!.backgroundPosition).toBe('2px 20px')
  })
  it('缩到很小时点变小', () => {
    expect(gridStyle('dots', { x: 0, y: 0, k: 0.1 })!.backgroundImage).toContain('0.8px')
    expect(gridStyle('dots', { x: 0, y: 0, k: 1 })!.backgroundImage).toContain('1.15px')
  })
  it('lines 用双 linear-gradient，dots 用 radial-gradient', () => {
    expect(gridStyle('lines', { x: 0, y: 0, k: 1 })!.backgroundImage.split('linear-gradient')).toHaveLength(3)
    expect(gridStyle('dots', { x: 0, y: 0, k: 1 })!.backgroundImage).toContain('radial-gradient')
  })
  it('图案色取中性底变量，不含暖色硬编码（L1-1-G2-A4）—— 两条分支都查', () => {
    const lines = gridStyle('lines', { x: 0, y: 0, k: 1 })!.backgroundImage
    expect(lines).toContain('var(--canvas-grid-line)')
    expect(lines).not.toMatch(/#[0-9a-f]{3,6}/i)
    expect(lines).not.toMatch(/rgba?\(/)
    // dots 分支同样不得硬编码颜色（只查 lines 会漏掉它）
    const dots = gridStyle('dots', { x: 0, y: 0, k: 1 })!.backgroundImage
    expect(dots).toContain('var(--canvas-grid-dot)')
    expect(dots).not.toMatch(/#[0-9a-f]{3,6}/i)
    expect(dots).not.toMatch(/rgba?\(/)
  })

  it('k 为 0/NaN 时不产出 NaN 偏移（浏览器会丢弃非法声明 → 图案变空白）', () => {
    for (const k of [0, Number.NaN]) {
      const s = gridStyle('lines', { x: 3, y: 4, k })!
      expect(s.backgroundSize).not.toContain('NaN')
      expect(s.backgroundPosition).not.toContain('NaN')
    }
  })
})
