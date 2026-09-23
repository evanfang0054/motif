import { describe, expect, it } from 'vitest'
import { clampScale, clampToolbarCenter, fitView, panBy, screenToWorld, toolbarAnchor, toolbarBand, worldToScreen, zoomAt, MAX_SCALE, MIN_SCALE, TOOLBAR_DROP, TOOLBAR_EDGE_GAP, TOOLBAR_LIFT } from '@/lib/canvas/viewport'
import { gridStyle } from '@/lib/canvas/grid'

describe('缩放锚点', () => {
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

describe('缩放钳制', () => {
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

  it('抬升量必须让开工具栏自身高度（否则工具栏会压住卡片顶部）', () => {
    // 工具栏 = 4px 内边距 ×2 + sm 图标按钮 32px + 1px 边框 ×2 ≈ 42px；抬升量小于它就会盖住图片
    expect(TOOLBAR_LIFT).toBeGreaterThanOrEqual(42)
  })

  it('单个矩形：锚在顶部居中并抬高 TOOLBAR_LIFT', () => {
    expect(toolbarAnchor([{ x: 100, y: 200, w: 240, h: 240 }], { x: 0, y: 0, k: 1 })).toEqual({
      left: 220,
      top: 200 - TOOLBAR_LIFT,
    })
  })

  it('多个矩形：取包围盒的顶部居中（不是第一张）', () => {
    // 包围盒 x 100..580（中心 340），顶部 y=200
    expect(
      toolbarAnchor(
        [
          { x: 100, y: 230, w: 240, h: 240 },
          { x: 340, y: 200, w: 240, h: 240 },
        ],
        { x: 0, y: 0, k: 1 }
      )
    ).toEqual({ left: 340, top: 200 - TOOLBAR_LIFT })
  })

  it('随视口平移缩放换算（与 worldToScreen 一致）', () => {
    const v = { x: 40, y: -20, k: 2 }
    const a = toolbarAnchor([{ x: 100, y: 200, w: 240, h: 240 }], v)!
    expect(a.left).toBe(100 * 2 + 40 + 240) // 中心 x=220 → 220*2+40
    expect(a.top).toBe(200 * 2 - 20 - TOOLBAR_LIFT)
  })

  it('贴顶（首行 y=0）翻到卡片下方：top = 底边屏幕 y + TOOLBAR_DROP，且不为负', () => {
    const a = toolbarAnchor([{ x: 100, y: 0, w: 240, h: 240 }], { x: 0, y: 0, k: 1 })!
    expect(a.top).toBe(240 + TOOLBAR_DROP)
    expect(a.top).toBeGreaterThanOrEqual(0)
    expect(a.left).toBe(220) // 水平仍是中心
  })

  it('翻转边界：屏幕顶距恰好等于 TOOLBAR_LIFT 时不翻转，差 1px 就翻转', () => {
    // 世界 y = 56、视口不动 → 屏幕 y = 56 = TOOLBAR_LIFT → top 正好 0，仍在卡片上方
    expect(toolbarAnchor([{ x: 100, y: TOOLBAR_LIFT, w: 240, h: 240 }], { x: 0, y: 0, k: 1 })).toEqual({
      left: 220,
      top: 0,
    })
    // 再往上 1px 就为负 → 翻到下方
    const flipped = toolbarAnchor([{ x: 100, y: TOOLBAR_LIFT - 1, w: 240, h: 240 }], { x: 0, y: 0, k: 1 })!
    expect(flipped.top).toBe(TOOLBAR_LIFT - 1 + 240 + TOOLBAR_DROP)
  })

  it('多矩形贴顶时按包围盒底边翻转', () => {
    const a = toolbarAnchor(
      [
        { x: 100, y: 0, w: 240, h: 240 },
        { x: 340, y: 0, w: 240, h: 300 },
      ],
      { x: 0, y: 0, k: 1 }
    )!
    expect(a.left).toBe(340)
    expect(a.top).toBe(300 + TOOLBAR_DROP) // 底边取最高的那张（h=300）
  })

  it('翻转也随视口缩放换算', () => {
    const a = toolbarAnchor([{ x: 100, y: 0, w: 240, h: 240 }], { x: 0, y: -30, k: 2 })!
    // 底边世界 y=240 → 屏幕 240*2-30=450，再 +TOOLBAR_DROP
    expect(a.top).toBe(450 + TOOLBAR_DROP)
  })
})

describe('背景图案', () => {
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
  it('图案色取中性底变量，不含暖色硬编码 —— 两条分支都查', () => {
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

describe('toolbarBand（工具栏可用横向区间）', () => {
  const HOST = 1200
  /** 宽屏左侧面板：left:12 / width:280 / 整列（top:12 起、足够高） */
  const left = (w = 280) => ({ side: 'left' as const, left: 12, top: 12, width: w, height: 800 })
  const right = (hostWidth = HOST, w = 372) => ({
    side: 'right' as const,
    left: hostWidth - 12 - w,
    top: 12,
    width: w,
    height: 800,
  })
  const TOOLBAR = { top: 300, height: 42 }

  it('没有面板时就是整个画布', () => {
    expect(toolbarBand(HOST, [], TOOLBAR)).toEqual({ left: 0, right: HOST })
  })

  it('两侧面板各扣各的占位', () => {
    expect(toolbarBand(HOST, [left(), right()], TOOLBAR)).toEqual({ left: 292, right: 1200 - 384 })
  })

  it('收起的面板（宽或高为 0）不占位', () => {
    expect(toolbarBand(HOST, [left(0), right(HOST, 0)], TOOLBAR)).toEqual({ left: 0, right: HOST })
  })

  it('窄屏通栏抽屉整块跳过（#82 复审 S1：只开右抽屉时不能被压成 {0,12}）', () => {
    // 窄屏 .ws-float-right 是 left:12 / right:12 / width:auto → 左右都贴边
    const drawer = { side: 'right' as const, left: 12, top: 400, width: HOST - 24, height: 300 }
    expect(toolbarBand(HOST, [drawer], TOOLBAR)).toEqual({ left: 0, right: HOST })
    // 左抽屉同理
    const leftDrawer = { side: 'left' as const, left: 12, top: 400, width: HOST - 24, height: 300 }
    expect(toolbarBand(HOST, [leftDrawer], TOOLBAR)).toEqual({ left: 0, right: HOST })
  })

  it('判据是「左右都贴画布边」而不是宽度比例：够宽但不贴边的面板仍按侧边占位算', () => {
    // 半屏宽的面板（左缘 800 远大于容差）—— 不是抽屉，必须扣掉
    const half = { side: 'right' as const, left: 800, top: 12, width: HOST * 0.5, height: 800 }
    expect(toolbarBand(HOST, [half], TOOLBAR)).toEqual({ left: 0, right: 800 })
    // 只有一侧贴边（右侧留了 200）→ 也不是通栏
    const lopsided = { side: 'right' as const, left: 12, top: 12, width: HOST - 212, height: 800 }
    expect(toolbarBand(HOST, [lopsided], TOOLBAR)).toEqual({ left: 0, right: 12 })
  })

  it('与工具栏纵向不重叠的顶部浮动条不参与钳制（#82 复审 S7）', () => {
    // 收起态浮动条：top:12 / 高 44。工具栏在画布中部（top 300）→ 不该被它挤走
    const collapsedLeft = { side: 'left' as const, left: 12, top: 12, width: 500, height: 44 }
    expect(toolbarBand(HOST, [collapsedLeft], TOOLBAR)).toEqual({ left: 0, right: HOST })
    // 工具栏正好在顶部（top 12..54）→ 这次必须让开
    expect(toolbarBand(HOST, [collapsedLeft], { top: 12, height: 42 })).toEqual({ left: 512, right: HOST })
  })
})

describe('clampToolbarCenter（工具栏横向钳制，#82）', () => {
  const HOST = 1000
  const BAND = { left: 0, right: 1000 }

  it('区间够宽时只在越界时钳住，区间内原样返回', () => {
    expect(clampToolbarCenter(500, 200, BAND, HOST)).toBe(500)
    // 右越界：中心最多到 right - 半宽 - 间隙
    expect(clampToolbarCenter(990, 200, BAND, HOST)).toBe(1000 - 100 - TOOLBAR_EDGE_GAP)
    // 左越界：对称
    expect(clampToolbarCenter(10, 200, BAND, HOST)).toBe(0 + 100 + TOOLBAR_EDGE_GAP)
  })

  it('扣掉两侧面板占位后，工具栏整体落在可用区间内（正是 #82 的判据）', () => {
    // 右面板占了 [800, 1000]，可用区间只剩 [0, 800]
    const band = { left: 0, right: 800 }
    const w = 260
    const center = clampToolbarCenter(900, w, band, HOST)
    expect(center + w / 2).toBeLessThanOrEqual(800)
    expect(center - w / 2).toBeGreaterThanOrEqual(0)
  })

  it('两侧面板都占位时同样成立', () => {
    const band = { left: 280, right: 700 }
    const w = 200
    const center = clampToolbarCenter(500, w, band, HOST)
    expect(center - w / 2).toBeGreaterThanOrEqual(280)
    expect(center + w / 2).toBeLessThanOrEqual(700)
  })

  it('可用区间比工具栏还窄时退化为区间中点，且**绝不越出画布**（#82 复审 S1）', () => {
    const band = { left: 0, right: 100 }
    const w = 400
    // 裸中点 50 会让工具栏左半（50-200）被裁掉 → 钳进画布后是 half
    expect(clampToolbarCenter(500, w, band, HOST)).toBe(w / 2 + TOOLBAR_EDGE_GAP)
    // 退化区间贴着画布右缘（只开右侧通栏抽屉时的旧算法会给出这种 band）：同样不能取裸中点
    const edge = { left: 0, right: 12 }
    const c = clampToolbarCenter(6, w, edge, HOST)
    expect(c).toBe(w / 2 + TOOLBAR_EDGE_GAP)
    expect(c - w / 2).toBeGreaterThanOrEqual(0)
    // 中点本身已在画布内时保持中点（不无谓地贴边）
    expect(clampToolbarCenter(500, 100, { left: 400, right: 600 }, HOST)).toBe(500)
  })

  it('画布本身比工具栏还窄时居中（左右各裁一点，不做无意义的越界钳制）', () => {
    expect(clampToolbarCenter(500, 400, { left: 0, right: 100 }, 120)).toBe(200 + TOOLBAR_EDGE_GAP)
  })
})
