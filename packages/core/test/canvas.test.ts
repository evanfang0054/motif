import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CANVAS_META,
  LINEAGE_COL_GAP,
  SLOT_GAP,
  SLOT_STEP,
  allocateSlots,
  centerRectsInViewport,
  displaySize,
  isCanvasRect,
  normalizeCanvasMeta,
  parseCanvasMeta,
  placementRect,
  planLineageColumn,
  planSlotRects,
  rectToPlacement,
  viewportOrigin,
} from '../src/index'

describe('normalizeCanvasMeta 容错（脏 JSON 不能把画布打不开）', () => {
  it('缺字段/空值回退默认', () => {
    expect(normalizeCanvasMeta(null)).toEqual(DEFAULT_CANVAS_META)
    expect(normalizeCanvasMeta(undefined)).toEqual(DEFAULT_CANVAS_META)
    expect(normalizeCanvasMeta({})).toEqual(DEFAULT_CANVAS_META)
  })

  it('非法 background 回退 lines', () => {
    expect(normalizeCanvasMeta({ background: 'rainbow' as never }).background).toBe('lines')
  })

  it('NaN / Infinity 视口回退默认', () => {
    expect(normalizeCanvasMeta({ viewport: { x: Number.NaN, y: Number.POSITIVE_INFINITY, k: 1 } }).viewport).toEqual({ x: 0, y: 0, k: 1 })
  })

  it('k <= 0 回退为正的默认缩放（否则 viewportOrigin 除零 → NaN → 落库 NOT NULL 崩）', () => {
    // 这是真实事故：k=0 落库后，GET 的补位会算出 NaN 位置，
    // SQLite 把 NaN 当 NULL 写进 NOT NULL 列 → 抛错 → 之后每次 GET 都 500，画布再也打不开。
    expect(normalizeCanvasMeta({ viewport: { k: 0 } }).viewport.k).toBe(1)
    expect(normalizeCanvasMeta({ viewport: { k: -2 } }).viewport.k).toBe(1)
  })
})

describe('parseCanvasMeta 容错', () => {
  it("升级库的 '{}' 与 null/空串都回退默认", () => {
    expect(parseCanvasMeta('{}')).toEqual(DEFAULT_CANVAS_META)
    expect(parseCanvasMeta(null)).toEqual(DEFAULT_CANVAS_META)
    expect(parseCanvasMeta('')).toEqual(DEFAULT_CANVAS_META)
  })

  it('脏 JSON 不抛错', () => {
    expect(parseCanvasMeta('{不是 json')).toEqual(DEFAULT_CANVAS_META)
    expect(parseCanvasMeta('"字符串"')).toEqual(DEFAULT_CANVAS_META)
    expect(parseCanvasMeta('null')).toEqual(DEFAULT_CANVAS_META)
  })
})

describe('viewportOrigin 必须是全函数（绝不产出 NaN/Infinity）', () => {
  it('默认视口原点为 (0,0)', () => {
    expect(viewportOrigin({ x: 0, y: 0, k: 1 })).toEqual({ x: 0, y: 0 })
  })

  it('平移后原点为负的平移量除以缩放', () => {
    expect(viewportOrigin({ x: -100, y: -50, k: 2 })).toEqual({ x: 50, y: 25 })
  })

  it('k=0 / 负数 / NaN 都退化为 k=1，不产出 NaN/Infinity', () => {
    for (const k of [0, -1, Number.NaN]) {
      const o = viewportOrigin({ x: -100, y: -50, k })
      expect(Number.isFinite(o.x)).toBe(true)
      expect(Number.isFinite(o.y)).toBe(true)
    }
  })
})

describe('displaySize', () => {
  it('按比例缩放到槽内，不放大', () => {
    expect(displaySize(1024, 1024)).toEqual({ width: 240, height: 240 })
    expect(displaySize(480, 240)).toEqual({ width: 240, height: 120 })
    expect(displaySize(100, 50)).toEqual({ width: 100, height: 50 })
  })

  it('原图尺寸未知（上传参考图 width/height 为 0）时回退正方形槽位', () => {
    expect(displaySize(0, 0)).toEqual({ width: 240, height: 240 })
    expect(displaySize(-1, 10)).toEqual({ width: 240, height: 240 })
  })
})

describe('allocateSlots', () => {
  it('从原点起 4 列排布，任意两个槽位互不重叠', () => {
    const slots = allocateSlots([], Array.from({ length: 8 }, () => ({ width: 240, height: 240 })), { x: 0, y: 0 })
    expect(slots[0]).toEqual({ x: 0, y: 0, w: 240, h: 240 })
    expect(slots[1]).toEqual({ x: 280, y: 0, w: 240, h: 240 })
    expect(slots[4]).toEqual({ x: 0, y: 280, w: 240, h: 240 })
    const overlaps = (a: typeof slots[number], b: typeof slots[number]) =>
      a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
    for (let i = 0; i < slots.length; i += 1) {
      for (let j = i + 1; j < slots.length; j += 1) expect(overlaps(slots[i], slots[j])).toBe(false)
    }
  })

  it('避开已占用的矩形', () => {
    const occupied = [{ x: 0, y: 0, w: 240, h: 240 }]
    const slots = allocateSlots(occupied, [{ width: 240, height: 240 }], { x: 0, y: 0 })
    expect(slots[0]).toEqual({ x: 280, y: 0, w: 240, h: 240 })
  })
})

describe('planSlotRects（#88 骨架槽位计划）', () => {
  const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

  it('数量 = 请求张数，且从视口原点起 4 列排布、互不重叠', () => {
    const slots = planSlotRects([], '1024x1024', 4, { x: 0, y: 0 })
    expect(slots).toHaveLength(4)
    expect(slots[0]).toEqual({ x: 0, y: 0, w: 240, h: 240 })
    expect(slots[1]).toEqual({ x: 280, y: 0, w: 240, h: 240 })
    expect(slots[4]).toBeUndefined()
    for (let i = 0; i < slots.length; i += 1) {
      for (let j = i + 1; j < slots.length; j += 1) expect(overlaps(slots[i], slots[j])).toBe(false)
    }
  })

  it('auto 一律按 1:1 占位（D13）', () => {
    // resolveSize('auto') → 1024×1024 → displaySize → 240×240（正方形）
    const slots = planSlotRects([], 'auto', 3, { x: 0, y: 0 })
    expect(slots.every((s) => s.w === 240 && s.h === 240)).toBe(true)
  })

  it('已知尺寸按各自比例占位（竖图 2:3 / 横图 3:2）', () => {
    expect(planSlotRects([], '1024x1536', 1, { x: 0, y: 0 })[0]).toEqual({ x: 0, y: 0, w: 160, h: 240 })
    expect(planSlotRects([], '1536x1024', 1, { x: 0, y: 0 })[0]).toEqual({ x: 0, y: 0, w: 240, h: 160 })
  })

  it('与「同尺寸逐个 allocateSlots」结果一致（出图不跳位的保证）', () => {
    const occupied = [{ x: 0, y: 0, w: 240, h: 240 }]
    const plan = planSlotRects(occupied, '1024x1024', 3, { x: 10, y: 20 })
    const stepwise: Array<{ x: number; y: number; w: number; h: number }> = []
    const acc = [...occupied]
    for (let i = 0; i < 3; i += 1) {
      const [s] = allocateSlots(acc, [{ width: 240, height: 240 }], { x: 10, y: 20 })
      acc.push(s)
      stepwise.push(s)
    }
    expect(plan).toEqual(stepwise)
  })
})

describe('planLineageColumn（血缘落位：新图/骨架落在参考图右侧一列）', () => {
  const overlaps = (
    a: { x: number; y: number; w: number; h: number },
    b: { x: number; y: number; w: number; h: number }
  ) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  /** 参考图：左上角 (0,0)、240 见方 */
  const anchor = { x: 0, y: 0, w: 240, h: 240 }
  const square = { width: 240, height: 240 }
  const filled = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ x: anchor.x + anchor.w + LINEAGE_COL_GAP, y: i * SLOT_STEP, w: 240, h: 240 }))

  it('列左缘 = 锚点右缘 + 列间距；列顶与锚点顶边对齐；列内按固定步长往下排', () => {
    const col = planLineageColumn([], [square, square, square], anchor)
    expect(col).toEqual([
      { x: 240 + LINEAGE_COL_GAP, y: 0, w: 240, h: 240 },
      { x: 240 + LINEAGE_COL_GAP, y: SLOT_STEP, w: 240, h: 240 },
      { x: 240 + LINEAGE_COL_GAP, y: SLOT_STEP * 2, w: 240, h: 240 },
    ])
  })

  it('跟着锚点走（锚点不在原点时绝不回到画布左上角）', () => {
    const col = planLineageColumn([], [square], { x: 1000, y: 700, w: 160, h: 240 })
    expect(col).toEqual([{ x: 1000 + 160 + LINEAGE_COL_GAP, y: 700, w: 240, h: 240 }])
  })

  it('同父第二次生成：整批落在上一批下方（同代同列，不另起一片）', () => {
    const first = planLineageColumn([], [square, square], anchor)!
    const second = planLineageColumn(first, [square], anchor)!
    // 第一批底边 = 280 + 240 = 520 → 第二批顶边 = 520 + SLOT_GAP
    expect(second).toEqual([{ x: 240 + LINEAGE_COL_GAP, y: SLOT_STEP + 240 + SLOT_GAP, w: 240, h: 240 }])
    for (const a of first) for (const b of second) expect(overlaps(a, b)).toBe(false)
  })

  it('列内步长**固定**：请求横图（占位高 160）时，出图更高也不会压到同列下一张', () => {
    // 请求 1536×1024 → 占位 240×160；网关若返回 1024×1024 → 实际 240×240。
    // 若按占位高度累加（160 + 40），第二张顶边只有 200 < 240 —— 压 40px，落位前校验会把第二张甩走。
    const wide = { width: 240, height: 160 }
    const col = planLineageColumn([], [wide, wide], anchor)!
    expect(col[1].y - col[0].y).toBe(SLOT_STEP)
    expect(overlaps({ x: col[0].x, y: col[0].y, w: 240, h: 240 }, col[1])).toBe(false)
  })

  it('锚点右侧那一竖条被占满 → 返回 null（调用方退回网格分配，不留半截计划）', () => {
    expect(planLineageColumn(filled(80), [square], anchor)).toBeNull()
  })

  it('空输入返回 null（不产出「0 个槽」的计划）', () => {
    expect(planLineageColumn([], [], anchor)).toBeNull()
  })
})

describe('planSlotRects 的血缘分支（有锚点走列、无锚点走原网格）', () => {
  const anchor = { x: 0, y: 0, w: 240, h: 240 }

  it('给了锚点 → 落在锚点右侧一列（骨架与出图同一条分支）', () => {
    const plan = planSlotRects([], '1024x1024', 2, { x: 999, y: 999 }, anchor)
    expect(plan).toEqual([
      { x: 240 + LINEAGE_COL_GAP, y: 0, w: 240, h: 240 },
      { x: 240 + LINEAGE_COL_GAP, y: SLOT_STEP, w: 240, h: 240 },
    ])
  })

  it('锚点为 null / 不传 → 与改动前逐值一致（纯文生图不受影响）', () => {
    const occupied = [{ x: 0, y: 0, w: 240, h: 240 }]
    const legacy = allocateSlots(occupied, [displaySize(1024, 1024)], { x: 10, y: 20 })
    expect(planSlotRects(occupied, '1024x1024', 1, { x: 10, y: 20 }, null)).toEqual(legacy)
    expect(planSlotRects(occupied, '1024x1024', 1, { x: 10, y: 20 })).toEqual(legacy)
  })

  it('锚点右侧竖条放不下 → 整体退回网格分配（不退化成空计划）', () => {
    // 竖条要**足够高**才算「占满」：每次尝试至少让过一个冲突矩形，尝试上限 64 次 ⇒
    // 2 张的批次每次让过 2 个槽（560），须备 >128 个冲突槽才耗尽预算。
    const blocked = Array.from({ length: 200 }, (_, i) => ({
      x: 240 + LINEAGE_COL_GAP,
      y: i * SLOT_STEP,
      w: 240,
      h: 240,
    }))
    const plan = planSlotRects(blocked, '1024x1024', 2, { x: 5000, y: 5000 }, anchor)
    expect(plan).toEqual([
      { x: 5000, y: 5000, w: 240, h: 240 },
      { x: 5000 + SLOT_STEP, y: 5000, w: 240, h: 240 },
    ])
  })
})

describe('centerRectsInViewport', () => {
  const eight = () => allocateSlots([], Array.from({ length: 8 }, () => ({ width: 240, height: 240 })), { x: 0, y: 0 })

  it('装得下时把包围盒摆到视口正中', () => {
    const slots = centerRectsInViewport(eight(), { x: 0, y: 0 }, 1400, 800)
    // 块 1080×520 → 左上角挪到 ((1400-1080)/2, (800-520)/2) = (160, 140)
    expect(slots[0]).toEqual({ x: 160, y: 140, w: 240, h: 240 })
    const minX = Math.min(...slots.map((r) => r.x))
    const maxX = Math.max(...slots.map((r) => r.x + r.w))
    const minY = Math.min(...slots.map((r) => r.y))
    const maxY = Math.max(...slots.map((r) => r.y + r.h))
    expect((minX + maxX) / 2).toBe(700)
    expect((minY + maxY) / 2).toBe(400)
  })

  it('装不下时退回左上角对齐（居中的话开头会被推到屏幕外）', () => {
    const slots = centerRectsInViewport(eight(), { x: 0, y: 0 }, 800, 400)
    expect(slots[0]).toEqual({ x: 0, y: 0, w: 240, h: 240 })
  })

  it('只在一个方向装得下时，只居中那一个方向', () => {
    // 宽 1080 ≤ 1400 → x 居中；高 520 > 400 → y 对齐原点
    const slots = centerRectsInViewport(eight(), { x: 0, y: 0 }, 1400, 400)
    expect(slots[0]).toEqual({ x: 160, y: 0, w: 240, h: 240 })
  })

  it('origin 非零时按 origin 的坐标系居中', () => {
    const rects = [{ x: 100, y: 200, w: 240, h: 240 }]
    // 视口左上角在世界坐标 (100, 200)，可见区 1000×600 → 块正好落在正中
    const slots = centerRectsInViewport(rects, { x: 100, y: 200 }, 1000, 600)
    expect(slots[0]).toEqual({ x: 480, y: 380, w: 240, h: 240 })
  })

  it('空数组原样返回（不做 Math.min，否则会得到 Infinity）', () => {
    expect(centerRectsInViewport([], { x: 0, y: 0 }, 1000, 600)).toEqual([])
  })
})

describe('placementRect / rectToPlacement 互逆', () => {
  it('矩形与摆放可互相转换', () => {
    const p = rectToPlacement('cimg_a', { x: 10, y: 20, w: 240, h: 120 }, '2026-09-20T10:00:00.000Z')
    expect(p).toEqual({ id: 'cimg_a', canvasX: 10, canvasY: 20, canvasWidth: 240, canvasHeight: 120, updatedAt: '2026-09-20T10:00:00.000Z' })
    expect(placementRect(p)).toEqual({ x: 10, y: 20, w: 240, h: 120 })
  })
})

/**
 * `isCanvasRect`：读库（`@motif/db` 的 `safeParseSlotPlan`）与读 API（`apps/web` 的
 * `pendingSkeletonSlots`）共用的同一份形状判据。两边口径必须一致 —— 槽位坐标直接喂给
 * `left/top/width/height`，坏值比「没有骨架」更糟。
 */
describe('isCanvasRect 形状判据（读库与读 API 共用）', () => {
  it('合法矩形通过', () => {
    expect(isCanvasRect({ x: 0, y: 0, w: 240, h: 240 })).toBe(true)
    expect(isCanvasRect({ x: -10, y: 5.5, w: 1, h: 1 })).toBe(true) // 负坐标合法，只要尺寸为正
  })

  it('非对象一律拒绝（含 null / undefined / 字符串 / 数字 / 数组）', () => {
    for (const v of [null, undefined, '[]', 42, true, []]) expect(isCanvasRect(v)).toBe(false)
  })

  it('缺字段 / 非数字 / 非有限数一律拒绝（NaN 与 Infinity 都会渲染出坏块）', () => {
    expect(isCanvasRect({ x: 0, y: 0, w: 240 })).toBe(false)
    expect(isCanvasRect({ x: '0', y: 0, w: 240, h: 240 })).toBe(false)
    expect(isCanvasRect({ x: NaN, y: 0, w: 240, h: 240 })).toBe(false)
    expect(isCanvasRect({ x: 0, y: Infinity, w: 240, h: 240 })).toBe(false)
  })

  it('尺寸为 0 或负数拒绝（不是合法矩形）', () => {
    expect(isCanvasRect({ x: 0, y: 0, w: 0, h: 240 })).toBe(false)
    expect(isCanvasRect({ x: 0, y: 0, w: 240, h: -1 })).toBe(false)
  })
})
