import { describe, expect, it } from 'vitest'
import { deriveLineage } from '@/lib/canvas/lineage'
import { parseCanvasExport, serializeCanvas } from '@/lib/canvas/serialization'
import { DEFAULT_CANVAS_META } from '@motif/core'

const img = (id: string, messageId: string | null, serial: number, origin: 'generated' | 'uploaded' = 'generated') => ({
  id, messageId, serial, origin,
})

describe('deriveLineage（D6 推导正确性）', () => {
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
