import { describe, expect, it } from 'vitest'
import {
  CANVAS_JSON_ENTRY,
  archiveEntryName,
  canvasArchiveEntries,
  mergeImportedPlacements,
  parseCanvasArchive,
} from '@/lib/canvas/archive'
import type { CanvasImagePlacement, CanvasMeta } from '@motif/core'

const META: CanvasMeta = { viewport: { x: 0, y: 0, k: 1 }, background: 'lines', version: 1 }
const bytes = (s: string) => new TextEncoder().encode(s)

function placement(id: string, x = 0, y = 0): CanvasImagePlacement {
  return { id, canvasX: x, canvasY: y, canvasWidth: 240, canvasHeight: 240, updatedAt: '2026-09-19T00:00:00.000Z' }
}

describe('归档条目命名', () => {
  it('含非 ASCII 的原名整段去掉，只留序号与扩展名（macOS unzip 的硬要求，见 #85）', () => {
    expect(archiveEntryName({ serial: 3, name: '参考图.png', src: '/s/3' })).toBe('files/003.png')
    expect(archiveEntryName({ serial: 5, name: '图片 1', src: '/s/5', mimeType: 'image/png' })).toBe('files/005.png')
    // 半截残渣（「-1」之类）比整段去掉更难认，故不做部分保留
    expect(archiveEntryName({ serial: 8, name: '图 1.png', src: '/s/8' })).toBe('files/008.png')
  })

  it('原名本身是 ASCII 时原样保留可读性', () => {
    expect(archiveEntryName({ serial: 1, name: 'hero-shot.jpg', src: '/s/1' })).toBe('files/001-hero-shot.jpg')
    // 非法字符仍替换（文件系统层面不能用）
    expect(archiveEntryName({ serial: 2, name: 'a/b:c?.jpg', src: '/s/2' })).toBe('files/002-a_b_c_.jpg')
  })

  it('无扩展名回退 bin / mime 推；空名回退到 src 末段', () => {
    // 空名时沿用既有回退链（`name` → src 末段 → 'image'），src 末段是 ASCII 故仍被保留
    expect(archiveEntryName({ serial: 4, name: '', src: '/s/4' })).toBe('files/004-4.bin')
    expect(archiveEntryName({ serial: 6, name: '图片 2', src: '/s/6', mimeType: 'image/jpeg' })).toBe('files/006.jpg')
    // 原名自带扩展名时优先用原名
    expect(archiveEntryName({ serial: 7, name: 'x.webp', src: '/s/7', mimeType: 'image/png' })).toBe('files/007-x.webp')
  })

  it('产出的条目名一律是纯 ASCII（这条是 #85 的实质判据）', () => {
    const names = [
      archiveEntryName({ serial: 1, name: '参考图.png', src: '/s/1' }),
      archiveEntryName({ serial: 2, name: '商品主图 2.jpeg', src: '/s/2' }),
      archiveEntryName({ serial: 3, name: '图片 3', src: '/s/3', mimeType: 'image/webp' }),
      archiveEntryName({ serial: 4, name: 'hero.png', src: '/s/4' }),
    ]
    for (const n of names) {
      expect(n, n).toMatch(/^[\x20-\x7e]+$/)
    }
  })
})

describe('导出条目清单', () => {
  it('第 1 条是 canvas.json 且文本可被 parseCanvasExport 解析', () => {
    const entries = canvasArchiveEntries({
      topicId: 'top_1',
      meta: META,
      images: [placement('cimg_a')],
      archiveImages: [{ id: 'cimg_a', serial: 1, name: 'a.png', src: '/s/a' }],
      exportedAt: '2026-09-20T10:00:00.000Z',
    })
    expect(entries[0].name).toBe(CANVAS_JSON_ENTRY)
    expect(entries[0].text).toContain('"app": "motif"')
    expect(entries).toHaveLength(2)
    expect(entries[1]).toEqual({ name: 'files/001-a.png', src: '/s/a' })
  })

  it('形状非法的摆放直接抛错（不静默产出坏归档）', () => {
    expect(() =>
      canvasArchiveEntries({
        topicId: 'top_1',
        meta: META,
        images: [{ id: 'x' } as unknown as CanvasImagePlacement],
        archiveImages: [],
        exportedAt: '2026-09-20T10:00:00.000Z',
      })
    ).toThrow(/形状非法/)
  })
})

describe('解析归档', () => {
  it('缺 canvas.json 抛错', () => {
    expect(() => parseCanvasArchive(new Map([['files/001-a.png', bytes('x')]]))).toThrow(/canvas.json/)
  })

  it('canvas.json 内容非法时抛既有校验文案', () => {
    const files = new Map([[CANVAS_JSON_ENTRY, bytes('{"app":"other","version":1}')]])
    expect(() => parseCanvasArchive(files)).toThrow(/不是 Motif 画布文件/)
  })

  it('合法归档能往返（导出 → 解析回同一份结构）', () => {
    const entries = canvasArchiveEntries({
      topicId: 'top_1',
      meta: META,
      images: [placement('cimg_a', 10, 20)],
      archiveImages: [],
      exportedAt: '2026-09-20T10:00:00.000Z',
    })
    const parsed = parseCanvasArchive(new Map([[CANVAS_JSON_ENTRY, bytes(entries[0].text!)]]))
    expect(parsed.topicId).toBe('top_1')
    expect(parsed.images[0]).toMatchObject({ id: 'cimg_a', canvasX: 10, canvasY: 20 })
  })
})

describe('导入合并（LWW 关键点）', () => {
  const NOW = '2026-09-20T12:00:00.000Z'

  it('命中项**必须重盖 updatedAt**（否则旧戳会被服务端 LWW 整批拒掉）', () => {
    const { applied } = mergeImportedPlacements([placement('cimg_a')], [placement('cimg_a', 300, 400)], NOW)
    expect(applied).toHaveLength(1)
    expect(applied[0]).toMatchObject({ canvasX: 300, canvasY: 400 })
    expect(applied[0].updatedAt).toBe(NOW)
    expect(applied[0].updatedAt).not.toBe('2026-09-19T00:00:00.000Z')
  })

  it('库里没有的 id 进 skipped，且不混进 applied', () => {
    const { applied, skipped } = mergeImportedPlacements(
      [placement('cimg_a')],
      [placement('cimg_a'), placement('cimg_gone')],
      NOW
    )
    expect(applied.map((p) => p.id)).toEqual(['cimg_a'])
    expect(skipped).toEqual(['cimg_gone'])
  })

  it('跨任务导入（全不命中）→ applied 空、skipped 全量', () => {
    const { applied, skipped } = mergeImportedPlacements(
      [placement('cimg_a')],
      [placement('cimg_x'), placement('cimg_y')],
      NOW
    )
    expect(applied).toEqual([])
    expect(skipped).toEqual(['cimg_x', 'cimg_y'])
  })
})

describe('原名映射（条目名改 ASCII 后的信息保全，#85）', () => {
  it('canvas.json 里带着 id → 原名，导入端能读回', () => {
    const entries = canvasArchiveEntries({
      topicId: 'top_1',
      meta: META,
      images: [placement('cimg_a'), placement('cimg_b')],
      archiveImages: [
        { id: 'cimg_a', serial: 1, name: '参考图.png', src: '/s/a' },
        { id: 'cimg_b', serial: 2, name: '商品主图 2', src: '/s/b', mimeType: 'image/jpeg' },
      ],
      exportedAt: '2026-09-20T10:00:00.000Z',
    })
    // 条目名一律 ASCII
    for (const e of entries) expect(e.name).toMatch(/^[\x20-\x7e]+$/)
    // 原名没丢，落在 canvas.json 里
    const parsed = parseCanvasArchive(new Map([[CANVAS_JSON_ENTRY, bytes(entries[0].text!)]]))
    expect(parsed.names).toEqual({ cimg_a: '参考图.png', cimg_b: '商品主图 2' })
  })

  it('老归档（没有 names 字段）仍能解析，names 为空', () => {
    const legacy = JSON.stringify({
      app: 'motif', version: 1, exportedAt: '', topicId: 'top_1', meta: META,
      images: [placement('cimg_a')],
    })
    const parsed = parseCanvasArchive(new Map([[CANVAS_JSON_ENTRY, bytes(legacy)]]))
    expect(parsed.names).toBeUndefined()
    expect(parsed.images).toHaveLength(1)
  })

  it('names 形状不对时当没有（它是附加信息，不该让导入失败）', () => {
    const bad = JSON.stringify({
      app: 'motif', version: 1, exportedAt: '', topicId: 'top_1', meta: META,
      images: [placement('cimg_a')], names: { cimg_a: 123 },
    })
    expect(parseCanvasArchive(new Map([[CANVAS_JSON_ENTRY, bytes(bad)]]))).toMatchObject({ topicId: 'top_1' })
  })

  it('空映射读出来也是「没有」——与写端对称（否则读成 {}、写回去又消失）', () => {
    const empty = JSON.stringify({
      app: 'motif', version: 1, exportedAt: '', topicId: 'top_1', meta: META,
      images: [placement('cimg_a')], names: {},
    })
    expect(parseCanvasArchive(new Map([[CANVAS_JSON_ENTRY, bytes(empty)]])).names).toBeUndefined()
  })
})
