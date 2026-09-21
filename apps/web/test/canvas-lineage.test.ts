import { describe, expect, it } from 'vitest'
import { chainBounds, deriveLineage, edgePath, isSameLayout, layoutLineageTree, lineageLayerModel } from '@/lib/canvas/lineage'
import { parseCanvasExport, serializeCanvas } from '@/lib/canvas/serialization'
import { DEFAULT_CANVAS_META } from '@motif/core'

const img = (id: string, messageId: string | null, serial: number, origin: 'generated' | 'uploaded' = 'generated') => ({
  id, messageId, serial, origin,
})

describe('deriveLineage 血缘与版本链推导', () => {
  it('同一 message 的产出聚成一簇，按 serial 升序', () => {
    const l = deriveLineage({
      images: [img('b', 'msg_1', 2), img('a', 'msg_1', 1), img('c', 'msg_2', 3)],
      messages: [{ id: 'msg_1', referenceIds: [] }, { id: 'msg_2', referenceIds: [] }],
    })
    expect(l.chains).toEqual([
      { messageId: 'msg_1', imageIds: ['a', 'b'] },
      { messageId: 'msg_2', imageIds: ['c'] },
    ])
  })

  it('reference_ids 推出 A → B 血缘', () => {
    const l = deriveLineage({
      images: [img('a', null, 1, 'uploaded'), img('b', 'msg_1', 2)],
      messages: [{ id: 'msg_1', referenceIds: ['a'] }],
    })
    expect(l.edges).toEqual([{ from: 'a', to: 'b' }])
  })

  it('同一轮的 N 张产出都连到上游参考图', () => {
    const l = deriveLineage({
      images: [img('a', null, 1, 'uploaded'), img('b', 'msg_1', 2), img('c', 'msg_1', 3)],
      messages: [{ id: 'msg_1', referenceIds: ['a'] }],
    })
    expect(l.edges).toEqual([{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }])
  })

  it('空 reference_ids 无上游', () => {
    const l = deriveLineage({
      images: [img('a', 'msg_1', 1)],
      messages: [{ id: 'msg_1', referenceIds: [] }],
    })
    expect(l.edges).toEqual([])
  })

  it('uploaded 且 message_id 为空的是血缘根', () => {
    const l = deriveLineage({
      images: [img('a', null, 1, 'uploaded'), img('b', 'msg_1', 2), img('c', null, 3, 'uploaded')],
      messages: [{ id: 'msg_1', referenceIds: ['a'] }],
    })
    expect(l.roots.sort()).toEqual(['a', 'c'])
  })

  it('引用不存在的图 id 时忽略该边（不抛错）', () => {
    const l = deriveLineage({
      images: [img('b', 'msg_1', 1)],
      messages: [{ id: 'msg_1', referenceIds: ['cimg_gone'] }],
    })
    expect(l.edges).toEqual([])
  })

  it('自引用被剔除', () => {
    const l = deriveLineage({
      images: [img('a', 'msg_1', 1)],
      messages: [{ id: 'msg_1', referenceIds: ['a'] }],
    })
    expect(l.edges).toEqual([])
  })

  it('message_id 为空但 origin=generated 的图不聚簇（不进 chains）', () => {
    const l = deriveLineage({ images: [img('a', null, 1)], messages: [] })
    expect(l.chains).toEqual([])
  })

  it('message_id 为 undefined 的 uploaded 图同样是血缘根（与文件内其余判定一致）', () => {
    const l = deriveLineage({
      images: [{ id: 'u', messageId: undefined as unknown as string | null, serial: 1, origin: 'uploaded' }],
      messages: [],
    })
    expect(l.roots).toEqual(['u'])
  })
})

describe('serializeCanvas / parseCanvasExport', () => {
  const input = {
    topicId: 'top_1',
    meta: DEFAULT_CANVAS_META,
    images: [{ id: 'cimg_a', canvasX: 1, canvasY: 2, canvasWidth: 3, canvasHeight: 4, updatedAt: '2026-09-20T00:00:00.000Z' }],
    exportedAt: '2026-09-20T00:00:00.000Z',
  }

  it('导出的 JSON 可原样解析回来（round-trip）', () => {
    const file = serializeCanvas(input)
    expect(file.app).toBe('motif')
    expect(file.version).toBe(1)
    expect(parseCanvasExport(JSON.stringify(file))).toEqual(file)
  })

  it('非本应用的 JSON 被拒', () => {
    expect(() => parseCanvasExport(JSON.stringify({ app: 'infinite-canvas', version: 3 }))).toThrow()
  })

  it('坏 JSON 被拒（不静默返回空画布）', () => {
    expect(() => parseCanvasExport('{ not json')).toThrow()
  })

  it('缺 images 数组被拒', () => {
    expect(() => parseCanvasExport(JSON.stringify({ app: 'motif', version: 1, topicId: 't', meta: DEFAULT_CANVAS_META }))).toThrow()
  })

  it('images 里元素形状非法被拒（不能只查「是不是数组」）', () => {
    const base = { app: 'motif', version: 1, exportedAt: '', topicId: 't', meta: DEFAULT_CANVAS_META }
    const bad = [
      [{}],                                                                   // 缺全部字段
      [null],                                                                 // 非对象
      ['x'],                                                                  // 非对象
      [{ id: 'c', canvasX: 'abc', canvasY: 0, canvasWidth: 1, canvasHeight: 1, updatedAt: 't' }], // 位置非数字
      [{ id: 'c', canvasX: 0, canvasY: 0, canvasWidth: Number.NaN, canvasHeight: 1, updatedAt: 't' }], // NaN
      [{ id: 'c', canvasX: 0, canvasY: 0, canvasWidth: 0, canvasHeight: 1, updatedAt: 't' }],  // 尺寸非正
      [{ id: 'c', canvasX: 0, canvasY: 0, canvasWidth: 1, canvasHeight: 1, updatedAt: '' }],   // 空版本
    ]
    for (const images of bad) {
      expect(() => parseCanvasExport(JSON.stringify({ ...base, images }))).toThrow()
    }
  })

  it('topicId 为空串被拒', () => {
    const base = { app: 'motif', version: 1, exportedAt: '', images: [] }
    expect(() => parseCanvasExport(JSON.stringify({ ...base, topicId: '' }))).toThrow()
  })

  it('serializeCanvas 对形状非法的入参抛错（不静默洗白成 {}）', () => {
    expect(() => serializeCanvas({
      topicId: 'top_1',
      meta: DEFAULT_CANVAS_META,
      images: [null as never],
      exportedAt: '2026-09-20T00:00:00.000Z',
    })).toThrow()
  })
})

describe('edgePath 贴面连线', () => {
  const a = { x: 0, y: 0, w: 100, h: 80 }
  const b = { x: 300, y: 0, w: 100, h: 80 }

  it('目标在右侧：从右边中点连到左边中点（控制点外推 0.4 倍间距，封顶 120、且不超过 1/4 间距）', () => {
    expect(edgePath(a, b)).toBe('M 100 40 C 175 40, 225 40, 300 40')
  })

  it('目标在左侧：左右互换（从左边中点出发）', () => {
    expect(edgePath(b, a)).toBe('M 300 40 C 225 40, 175 40, 100 40')
  })

  it('目标在下方：走上/下边中点', () => {
    expect(edgePath(a, { x: 0, y: 300, w: 100, h: 80 })).toBe('M 50 80 C 50 155, 50 225, 50 300')
  })

  it('两端完全重合时端点仍在边上（不退化成 NaN）', () => {
    const same = { x: 0, y: 0, w: 100, h: 80 }
    const d = edgePath(same, same)
    expect(d).toBe('M 100 40 C 100 40, 0 40, 0 40')
  })

  it('端点恒落在矩形边上（对若干相对位置都成立）', () => {
    const targets = [
      { x: 400, y: 10, w: 60, h: 60 },
      { x: -300, y: 5, w: 60, h: 60 },
      { x: 20, y: 400, w: 60, h: 60 },
      { x: 10, y: -400, w: 60, h: 60 },
    ]
    const onEdge = (x: number, y: number, r: { x: number; y: number; w: number; h: number }) =>
      ((x === r.x || x === r.x + r.w) && y >= r.y && y <= r.y + r.h) ||
      ((y === r.y || y === r.y + r.h) && x >= r.x && x <= r.x + r.w)
    for (const t of targets) {
      const d = edgePath(a, t)
      const head = /^M ([\d.-]+) ([\d.-]+)/.exec(d)!
      const tail = /([\d.-]+) ([\d.-]+)$/.exec(d)!
      const sx = Number(head[1])
      const sy = Number(head[2])
      const ex = Number(tail[1])
      const ey = Number(tail[2])
      expect(onEdge(sx, sy, a)).toBe(true)
      expect(onEdge(ex, ey, t)).toBe(true)
    }
  })

  it('控制点外推有上下限（太近不低于下限、太远不超过上限）', () => {
    const near = edgePath({ x: 0, y: 0, w: 10, h: 10 }, { x: 15, y: 0, w: 10, h: 10 })
    expect(near).toBe('M 10 5 C 13.75 5, 11.25 5, 15 5')
    const far = edgePath({ x: 0, y: 0, w: 10, h: 10 }, { x: 2000, y: 0, w: 10, h: 10 })
    expect(far).toBe('M 10 5 C 130 5, 1880 5, 2000 5')
  })

  it('同输入恒同输出（无随机、无时间依赖）', () => {
    expect(edgePath(a, b)).toBe(edgePath(a, b))
  })
})

describe('chainBounds 同轮次分组框', () => {
  it('取并集并加屏幕内边距（世界单位 = padding / k）', () => {
    const rects = [
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 200, y: 50, w: 100, h: 100 },
    ]
    expect(chainBounds(rects, 1)).toEqual({ x: -16, y: -16, w: 332, h: 182 })
  })

  it('缩放变小 ⇒ 世界内边距变大，屏幕内边距不变', () => {
    const rects = [{ x: 0, y: 0, w: 100, h: 100 }]
    const at1 = chainBounds(rects, 1)!
    const atHalf = chainBounds(rects, 0.5)!
    expect(at1.x).toBe(-16)
    expect(atHalf.x).toBe(-32)
    // 屏幕内边距 = 世界内边距 × k，两者都是 16
    expect(-at1.x * 1).toBe(16)
    expect(-atHalf.x * 0.5).toBe(16)
  })

  it('空输入返回 null（不产出退化矩形）', () => {
    expect(chainBounds([], 1)).toBeNull()
  })

  it('缩放比非正时回退成 k=1 的内边距（不产出 NaN/Infinity）', () => {
    const rects = [{ x: 0, y: 0, w: 100, h: 100 }]
    expect(chainBounds(rects, 0)).toEqual({ x: -16, y: -16, w: 132, h: 132 })
    expect(chainBounds(rects, -1)).toEqual({ x: -16, y: -16, w: 132, h: 132 })
  })
})

describe('lineageLayerModel 图层模型', () => {
  const images = [
    { id: 'cimg_up', messageId: null, serial: 1, origin: 'uploaded' as const },
    { id: 'cimg_a', messageId: 'msg_1', serial: 2, origin: 'generated' as const },
    { id: 'cimg_b', messageId: 'msg_1', serial: 3, origin: 'generated' as const },
  ]
  const messages = [{ id: 'msg_1', referenceIds: ['cimg_up'] }]
  const placements = {
    cimg_up: { x: 0, y: 0, w: 100, h: 100 },
    cimg_a: { x: 200, y: 0, w: 100, h: 100 },
    cimg_b: { x: 200, y: 150, w: 100, h: 100 },
  }

  it('产出两条血缘边与一个同轮次分组框', () => {
    const model = lineageLayerModel({ lineage: deriveLineage({ images, messages }), placements, k: 1 })!
    expect(model.edges.map((e) => e.key)).toEqual(['cimg_up\u0000cimg_a', 'cimg_up\u0000cimg_b'])
    expect(model.groups).toHaveLength(1)
    expect(model.groups[0].key).toBe('msg_1')
    expect(model.groups[0].label).toBe('同一轮 · 2 张')
  })

  it('两端都缺摆放时既无边也无框 ⇒ 整层不挂载（不画到原点）', () => {
    const model = lineageLayerModel({
      lineage: deriveLineage({ images, messages }),
      placements: { cimg_up: placements.cimg_up },
      k: 1,
    })
    expect(model).toBeNull()
  })

  it('轮次成员不齐时不画框，但边照画', () => {
    const model = lineageLayerModel({
      lineage: deriveLineage({ images, messages }),
      placements: { cimg_up: placements.cimg_up, cimg_a: placements.cimg_a },
      k: 1,
    })!
    expect(model.edges).toHaveLength(1)
    expect(model.groups).toHaveLength(0)
  })

  it('单张轮次不画框（没有「并排」可言）', () => {
    const one = [images[0], images[1]]
    const model = lineageLayerModel({ lineage: deriveLineage({ images: one, messages }), placements, k: 1 })!
    expect(model.groups).toHaveLength(0)
  })

  it('无可画内容时返回 null（组件据此不挂载整层）', () => {
    const model = lineageLayerModel({
      lineage: deriveLineage({ images: [{ id: 'cimg_x', messageId: null, serial: 1, origin: 'uploaded' }], messages: [] }),
      placements: { cimg_x: { x: 0, y: 0, w: 10, h: 10 } },
      k: 1,
    })
    expect(model).toBeNull()
  })
})

describe('layoutLineageTree 按血缘分层铺开', () => {
  const mk = (id: string, messageId: string | null, serial: number, w = 200, h = 100) => ({
    id,
    messageId,
    serial,
    origin: (messageId ? 'generated' : 'uploaded') as 'generated' | 'uploaded',
    size: { width: w, height: h },
  })
  // up（上传）→ 第一轮 g1/g2 → 第二轮 g3
  const images = [mk('up', null, 1), mk('g1', 'm1', 2), mk('g2', 'm1', 3), mk('g3', 'm2', 4)]
  const messages = [
    { id: 'm1', referenceIds: ['up'] },
    { id: 'm2', referenceIds: ['g1'] },
  ]
  const lineage = deriveLineage({ images, messages })
  const layout = layoutLineageTree({ images, lineage, origin: { x: 1000, y: 500 } })
  const at = (id: string) => layout.find((l) => l.id === id)!.rect

  it('没有上游的在最左列，逐代向右且列间不重叠', () => {
    expect(at('up').x).toBe(1000)
    expect(at('g1').x).toBeGreaterThan(at('up').x + at('up').w)
    expect(at('g3').x).toBeGreaterThan(at('g1').x + at('g1').w)
  })

  it('同一轮的产出同列、按 serial 连续堆叠（版本链并排）', () => {
    expect(at('g1').x).toBe(at('g2').x)
    expect(at('g2').y - (at('g1').y + at('g1').h)).toBe(48)
  })

  it('每列以 origin.y 竖直居中', () => {
    expect(at('up').y + at('up').h / 2).toBe(500)
    expect(at('g3').y + at('g3').h / 2).toBe(500)
  })

  it('没有上游的一轮全在最左列（诚实：它们确实没有上游）', () => {
    const solo = [mk('a', 'm9', 1), mk('b', 'm9', 2), mk('c', 'm9', 3)]
    const out = layoutLineageTree({ images: solo, lineage: deriveLineage({ images: solo, messages: [] }), origin: { x: 0, y: 0 } })
    expect(new Set(out.map((o) => o.rect.x)).size).toBe(1)
    expect(out.map((o) => o.id)).toEqual(['a', 'b', 'c'])
    expect(out[1].rect.y).toBeGreaterThan(out[0].rect.y)
  })

  it('列宽按该列最宽的卡片定，列内不同宽度也不重叠', () => {
    const mixed = [mk('p', null, 1, 300, 100), mk('q', 'm1', 2, 120, 60)]
    const out = layoutLineageTree({
      images: mixed,
      lineage: deriveLineage({ images: mixed, messages: [{ id: 'm1', referenceIds: ['p'] }] }),
      origin: { x: 0, y: 0 },
    })
    const p = out.find((o) => o.id === 'p')!.rect
    const q = out.find((o) => o.id === 'q')!.rect
    expect(q.x).toBe(p.w + 120)
  })

  it('血缘成环时按「就地归零」处理，不递归、不抛错', () => {
    const cyc = [mk('a', 'm1', 1), mk('b', 'm2', 2)]
    const cycLineage = deriveLineage({
      images: cyc,
      messages: [
        { id: 'm1', referenceIds: ['b'] },
        { id: 'm2', referenceIds: ['a'] },
      ],
    })
    const out = layoutLineageTree({ images: cyc, lineage: cycLineage, origin: { x: 0, y: 0 } })
    expect(out).toHaveLength(2)
    expect(out.every((o) => Number.isFinite(o.rect.x) && Number.isFinite(o.rect.y))).toBe(true)
  })

  it('空输入返回空数组', () => {
    expect(layoutLineageTree({ images: [], lineage: { edges: [], chains: [], roots: [] }, origin: { x: 0, y: 0 } })).toEqual([])
  })
})

describe('isSameLayout 引导提示的去抖与「整理」的幂等', () => {
  const plan = [
    { id: 'a', rect: { x: 0, y: 0, w: 200, h: 100 } },
    { id: 'b', rect: { x: 320, y: -50, w: 200, h: 100 } },
  ]

  it('逐值一致（含容差内）⇒ true', () => {
    expect(isSameLayout(plan, { a: { x: 0, y: 0, w: 200, h: 100 }, b: { x: 320, y: -50, w: 200, h: 100 } })).toBe(true)
    expect(isSameLayout(plan, { a: { x: 0.5, y: -0.5, w: 200.5, h: 100 }, b: { x: 320, y: -50, w: 200, h: 100 } })).toBe(true)
  })

  it('超出容差的位置或尺寸差异 ⇒ false', () => {
    expect(isSameLayout(plan, { a: { x: 40, y: 0, w: 200, h: 100 }, b: { x: 320, y: -50, w: 200, h: 100 } })).toBe(false)
    expect(isSameLayout(plan, { a: { x: 0, y: 0, w: 260, h: 100 }, b: { x: 320, y: -50, w: 200, h: 100 } })).toBe(false)
  })

  it('缺摆放 ⇒ false（有图没排到，就还有事可做）', () => {
    expect(isSameLayout(plan, { a: { x: 0, y: 0, w: 200, h: 100 } })).toBe(false)
  })

  it('空计划 ⇒ true（没什么可整理）', () => {
    expect(isSameLayout([], {})).toBe(true)
  })

  it('与 layoutLineageTree 自洽：排完之后计划与摆放一致（幂等）', () => {
    const images = [
      { id: 'up', messageId: null, serial: 1, size: { width: 200, height: 100 } },
      { id: 'g1', messageId: 'm1', serial: 2, size: { width: 200, height: 100 } },
      { id: 'g2', messageId: 'm1', serial: 3, size: { width: 200, height: 100 } },
    ]
    const lineage = deriveLineage({
      images: images.map((i) => ({ ...i, origin: (i.messageId ? 'generated' : 'uploaded') as 'generated' | 'uploaded' })),
      messages: [{ id: 'm1', referenceIds: ['up'] }],
    })
    const origin = { x: 0, y: 0 }
    const first = layoutLineageTree({ images, lineage, origin })
    const placements = Object.fromEntries(first.map((o) => [o.id, o.rect]))
    // 整理完内容包围盒 = 树的包围盒 ⇒ 再算一次结果相同（origin 锚在内容上，不随视口漂移）
    const again = layoutLineageTree({ images, lineage, origin })
    expect(isSameLayout(again, placements)).toBe(true)
    expect(isSameLayout(first, placements)).toBe(true)
  })
})

describe('isSameLayout 作「是否该提示整理」的判据（带轻推容差）', () => {
  const images = [
    { id: 'up', messageId: null, serial: 1, size: { width: 240, height: 180 } },
    { id: 'g1', messageId: 'm1', serial: 2, size: { width: 240, height: 180 } },
    { id: 'g2', messageId: 'm1', serial: 3, size: { width: 240, height: 180 } },
  ]
  const lineage = deriveLineage({
    images: images.map((i) => ({ ...i, origin: (i.messageId ? 'generated' : 'uploaded') as 'generated' | 'uploaded' })),
    messages: [{ id: 'm1', referenceIds: ['up'] }],
  })
  const plan = layoutLineageTree({ images, lineage, origin: { x: 0, y: 0 } })

  it('按行铺的网格 ⇒ 判为「不一致」（该提示整理）', () => {
    const grid = {
      up: { x: 100, y: 100, w: 240, h: 180 },
      g1: { x: 400, y: 100, w: 240, h: 180 },
      g2: { x: 700, y: 100, w: 240, h: 180 },
    }
    expect(isSameLayout(plan, grid, 80)).toBe(false)
  })

  it('手工轻推（偏差在容差内）⇒ 判为「一致」（不打扰）', () => {
    const nudged = Object.fromEntries(plan.map((p) => [p.id, { ...p.rect, x: p.rect.x + 40, y: p.rect.y - 30 }]))
    expect(isSameLayout(plan, nudged, 80)).toBe(true)
    expect(isSameLayout(plan, nudged, 20)).toBe(false)
  })

  it('推得太远（超出容差）⇒ 判为「不一致」', () => {
    const moved = Object.fromEntries(plan.map((p) => [p.id, { ...p.rect }]))
    moved.g2 = { ...moved.g2, y: moved.g2.y + 300 }
    expect(isSameLayout(plan, moved, 80)).toBe(false)
  })
})
