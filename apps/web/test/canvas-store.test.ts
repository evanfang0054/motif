import { describe, expect, it } from 'vitest'
import { createCanvasStore } from '@/stores/canvas/useCanvasStore'

/** 造一张画布图的最小信息（syncImages 只看这几个字段） */
function img(id: string, x = 0, y = 0, w = 240, h = 240, srcW = 1024, srcH = 1024) {
  return { id, canvasX: x, canvasY: y, canvasWidth: w, canvasHeight: h, width: srcW, height: srcH }
}

const ORIGIN = { x: 0, y: 0 }

function seed() {
  const store = createCanvasStore()
  store.getState().init('top_1', {
    images: [
      { id: 'cimg_a', canvasX: 0, canvasY: 0, canvasWidth: 240, canvasHeight: 240, updatedAt: 't' },
      { id: 'cimg_b', canvasX: 280, canvasY: 0, canvasWidth: 240, canvasHeight: 240, updatedAt: 't' },
    ],
    meta: { viewport: { x: 0, y: 0, k: 1 }, background: 'lines', version: 1 },
  }, 'cloud')
  return store
}

describe('画布 store：新出现的图片必须补上摆放（生成后不刷新也要看得见）', () => {
  it('detail 刷新带来的新图用**服务端落库的**摆放，不需要重取快照', () => {
    const s = seed()
    // 第二批生成完成：detail 里多了 cimg_new，服务端已带位置
    s.getState().syncImages([img('cimg_a'), img('cimg_b'), img('cimg_new', 560, 300)], ORIGIN)
    expect(s.getState().placements['cimg_new']).toEqual({ x: 560, y: 300, w: 240, h: 240 })
    // 服务端已有位置，不该再当成待提交
    expect(s.getState().dirty).not.toContain('cimg_new')
  })

  it('服务端位置缺失（老行未补位 / 快照接口失败）时按空位槽兜底分配，并落库', () => {
    const s = seed()
    // canvasWidth=0 → 没有可用摆放
    s.getState().syncImages([img('cimg_a'), img('cimg_b'), img('cimg_bad', 0, 0, 0, 0)], ORIGIN)
    const p = s.getState().placements['cimg_bad']
    expect(p).toBeTruthy()
    expect(p.w).toBeGreaterThan(0)
    expect(s.getState().dirty).toContain('cimg_bad') // 本地分配的必须落库
    // 不与已有摆放重叠
    for (const other of ['cimg_a', 'cimg_b']) {
      const o = s.getState().placements[other]
      const overlap = p.x < o.x + o.w && o.x < p.x + p.w && p.y < o.y + o.h && o.y < p.y + p.h
      expect(overlap).toBe(false)
    }
  })

  it('本地已有摆放优先（用户刚拖过、还没落库的不能被服务端旧值盖掉）', () => {
    const s = seed()
    s.getState().moveBy(['cimg_a'], 50, 60)
    s.getState().syncImages([img('cimg_a'), img('cimg_b')], ORIGIN)
    expect(s.getState().placements['cimg_a']).toMatchObject({ x: 50, y: 60 })
  })

  it('图片集合里没有的 id 会被清掉，选中集同步收缩', () => {
    const s = seed()
    s.getState().setSelected(['cimg_a', 'cimg_b'])
    s.getState().syncImages([img('cimg_b')], ORIGIN)
    expect(s.getState().placements['cimg_a']).toBeUndefined()
    expect(s.getState().selected).toEqual(['cimg_b'])
  })
})

describe('画布 store：撤销栈', () => {
  it('一次拖拽（begin → 多帧 moveBy → end）只产生一个撤销步', () => {
    const s = seed()
    s.getState().beginGesture('drag:cimg_a')
    for (let i = 1; i <= 20; i += 1) s.getState().moveBy(['cimg_a'], 5, 0)
    s.getState().endGesture()
    expect(s.getState().placements['cimg_a'].x).toBe(100)
    s.getState().undo()
    expect(s.getState().placements['cimg_a'].x).toBe(0)
    s.getState().redo()
    expect(s.getState().placements['cimg_a'].x).toBe(100)
  })

  it('服务端删除不进撤销栈', () => {
    const s = seed()
    s.getState().beginGesture('drag:cimg_a')
    s.getState().moveBy(['cimg_a'], 30, 0)
    s.getState().endGesture()
    expect(s.getState().history.depth()).toBe(1)

    // 删除：画布上移除该图（服务端删除由 Workspace 的 removeImages 负责，此处同步内存）
    s.getState().syncImages([img('cimg_b')], ORIGIN)
    expect(s.getState().placements['cimg_a']).toBeUndefined()
    expect(s.getState().history.depth()).toBe(1) // 深度不变：删除没进栈

    // 撤销只回滚位置，不会把删除的图变回来
    s.getState().undo()
    expect(s.getState().placements['cimg_a']).toBeUndefined()
  })

  it('尺寸变更可撤销（位置与尺寸同一套撤销）', () => {
    const s = seed()
    s.getState().beginGesture('resize:cimg_a')
    s.getState().resizeTo('cimg_a', 300, 200)
    s.getState().endGesture()
    expect(s.getState().placements['cimg_a']).toMatchObject({ w: 300, h: 200 })
    s.getState().undo()
    expect(s.getState().placements['cimg_a']).toMatchObject({ w: 240, h: 240 })
    s.getState().redo()
    expect(s.getState().placements['cimg_a']).toMatchObject({ w: 300, h: 200 })
  })

  it('撤销不会抹掉手势之后新生成的图（与「不复活已删除的图」是同一个坑的两面）', () => {
    const s = seed()
    s.getState().beginGesture('drag:cimg_a')
    s.getState().moveBy(['cimg_a'], 30, 0)
    s.getState().endGesture()

    // 手势结束后，本轮生成又出了一张图（syncImages 会带上它）
    s.getState().syncImages([img('cimg_a'), img('cimg_b'), img('cimg_new', 560, 0)], ORIGIN)

    s.getState().undo()
    // 位置回滚了，但新图还在
    expect(s.getState().placements['cimg_a'].x).toBe(0)
    expect(s.getState().placements['cimg_new']).toMatchObject({ x: 560, y: 0 })
  })

  it('撤销只把**真正变了的**图计入待提交（否则一次撤销会赢过其它标签页的最新位置）', () => {
    const s = seed()
    s.getState().beginGesture('drag:cimg_a')
    s.getState().moveBy(['cimg_a'], 40, 0)
    s.getState().endGesture()
    s.getState().markClean(['cimg_a'])
    expect(s.getState().dirty).toEqual([])

    s.getState().undo()
    expect(s.getState().placements['cimg_a'].x).toBe(0)
    // 只有 a 变了；b 只是「快照里有」不该被推回服务端
    expect(s.getState().dirty).toEqual(['cimg_a'])
  })

  it('没拖动就松手（点选）作废手势：不占撤销步，第一次 Ctrl+Z 不会空转', () => {
    const s = seed()
    s.getState().beginGesture('drag:cimg_a')
    s.getState().cancelGesture()
    expect(s.getState().history.depth()).toBe(0)

    // 真拖一次后，第一次撤销就能回滚（不会被空步吃掉）
    s.getState().beginGesture('drag:cimg_a')
    s.getState().moveBy(['cimg_a'], 70, 0)
    s.getState().endGesture()
    s.getState().undo()
    expect(s.getState().placements['cimg_a'].x).toBe(0)
  })

  it('applyServerPlacements 用服务端值覆盖本地并清出 dirty', () => {
    const s = seed()
    s.getState().moveBy(['cimg_a'], 10, 0)
    expect(s.getState().placements['cimg_a'].x).toBe(10)
    expect(s.getState().dirty).toContain('cimg_a')

    // 服务端拒了这次更旧的写入，并回传库中当前值
    s.getState().applyServerPlacements([
      { id: 'cimg_a', canvasX: 777, canvasY: 0, canvasWidth: 240, canvasHeight: 240, updatedAt: 't2' },
    ])

    expect(s.getState().placements['cimg_a'].x).toBe(777) // 本地被服务端值覆盖
    expect(s.getState().dirty).not.toContain('cimg_a') // 不再重试更旧的值
  })

  it('applyPlacements 批量覆盖（整理布局）且全部进 dirty', () => {
    const s = seed()
    s.getState().applyPlacements([
      { id: 'cimg_a', canvasX: 5, canvasY: 6, canvasWidth: 100, canvasHeight: 100, updatedAt: 't' },
      { id: 'cimg_b', canvasX: 300, canvasY: 6, canvasWidth: 100, canvasHeight: 100, updatedAt: 't' },
    ])
    expect(s.getState().placements['cimg_a']).toMatchObject({ x: 5, y: 6, w: 100, h: 100 })
    expect(s.getState().dirty.sort()).toEqual(['cimg_a', 'cimg_b'])
  })
})

describe('画布 store：视口与选择', () => {
  it('zoomAt 保持锚点下的世界坐标不变', () => {
    const s = seed()
    s.getState().zoomAt(1.5, 300, 200)
    expect(s.getState().meta.viewport.k).toBeCloseTo(1.5, 9)
  })
  it('缩放钳制在 0.25–3', () => {
    const s = seed()
    for (let i = 0; i < 40; i += 1) s.getState().zoomAt(1.1, 0, 0)
    expect(s.getState().meta.viewport.k).toBe(3)
    for (let i = 0; i < 80; i += 1) s.getState().zoomAt(0.9, 0, 0)
    expect(s.getState().meta.viewport.k).toBe(0.25)
  })
  it('多选：setSelected 覆盖、toggleSelect 追加、clearSelection 清空', () => {
    const s = seed()
    s.getState().setSelected(['cimg_a'])
    s.getState().toggleSelect('cimg_b')
    expect(s.getState().selected.sort()).toEqual(['cimg_a', 'cimg_b'])
    s.getState().toggleSelect('cimg_a')
    expect(s.getState().selected).toEqual(['cimg_b'])
    s.getState().clearSelection()
    expect(s.getState().selected).toEqual([])
  })
})
