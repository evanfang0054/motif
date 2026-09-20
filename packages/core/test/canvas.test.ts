import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CANVAS_META,
  allocateSlots,
  displaySize,
  normalizeCanvasMeta,
  parseCanvasMeta,
  placementRect,
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

describe('placementRect / rectToPlacement 互逆', () => {
  it('矩形与摆放可互相转换', () => {
    const p = rectToPlacement('cimg_a', { x: 10, y: 20, w: 240, h: 120 }, '2026-09-20T10:00:00.000Z')
    expect(p).toEqual({ id: 'cimg_a', canvasX: 10, canvasY: 20, canvasWidth: 240, canvasHeight: 120, updatedAt: '2026-09-20T10:00:00.000Z' })
    expect(placementRect(p)).toEqual({ x: 10, y: 20, w: 240, h: 120 })
  })
})
