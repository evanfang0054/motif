import { describe, expect, it } from 'vitest'
import { createCanvasHistory } from '@/lib/canvas/history'

type S = { n: number }

describe('撤销栈（L4-2-G2-A3）', () => {
  it('连续拖拽（20 帧）合并为一个撤销步', () => {
    const h = createCanvasHistory<S>()
    const s0 = { n: 0 }
    // 真实手势：pointerdown 时 begin 一次，之后每帧只改内存（store.moveBy）。
    h.begin('drag:cimg_a', s0)
    let live: S = { n: 0 }
    for (let i = 1; i <= 20; i += 1) {
      live = { n: i } // 每帧位置都在变，但不碰撤销栈
      // 即便实现在每帧都调一次 begin（常见写法），也必须因「同 key 不覆盖基准」而不长栈
      h.begin('drag:cimg_a', live)
    }
    expect(h.depth()).toBe(0) // 手势进行中：还没入栈
    h.commit()
    expect(h.depth()).toBe(1) // 20 帧只落 1 步
    expect(h.undo(live)).toEqual(s0) // 且回滚到手势**开始前**，不是第 19 帧
  })

  it('同一手势内重复 begin 不覆盖基准', () => {
    const h = createCanvasHistory<S>()
    h.begin('drag:cimg_a', { n: 0 })
    h.begin('drag:cimg_a', { n: 7 }) // 每帧都调，基准不能被覆盖
    h.commit()
    expect(h.undo({ n: 9 })).toEqual({ n: 0 })
  })

  it('两次不同手势 = 两步撤销，按后进先出', () => {
    const h = createCanvasHistory<S>()
    h.begin('drag:cimg_a', { n: 0 })
    h.commit()
    h.begin('drag:cimg_a', { n: 5 })
    h.commit()
    expect(h.depth()).toBe(2)
    expect(h.undo({ n: 9 })).toEqual({ n: 5 })
    expect(h.undo({ n: 5 })).toEqual({ n: 0 })
    expect(h.canUndo()).toBe(false)
  })

  it('undo 后可 redo 回原位', () => {
    const h = createCanvasHistory<S>()
    h.begin('drag:cimg_a', { n: 0 })
    h.commit()
    expect(h.undo({ n: 9 })).toEqual({ n: 0 })
    expect(h.canRedo()).toBe(true)
    expect(h.redo({ n: 0 })).toEqual({ n: 9 })
  })

  it('新的手势清空重做栈', () => {
    const h = createCanvasHistory<S>()
    h.begin('drag:cimg_a', { n: 0 })
    h.commit()
    h.undo({ n: 9 })
    h.begin('drag:cimg_b', { n: 0 })
    h.commit()
    expect(h.canRedo()).toBe(false)
  })

  it('未 begin 时 commit 无操作、undo 返回 null（删除不进栈的机制保证）', () => {
    const h = createCanvasHistory<S>()
    // 服务端删除（removeImages）走的是完全不同的路径，从不调 begin/commit ——
    // 故撤销栈里不可能有删除操作（与「删除后无法恢复」文案一致；
    // 该文案由 `deleteImageConfirmText` 产出，渲染于 Workspace.tsx:561）
    h.commit()
    expect(h.depth()).toBe(0)
    expect(h.canUndo()).toBe(false)
    expect(h.undo({ n: 1 })).toBeNull()
  })

  it('超过上限时丢弃最旧的（limit 生效）', () => {
    const h = createCanvasHistory<S>(3)
    for (let i = 0; i < 5; i += 1) {
      h.begin(`g${i}`, { n: i })
      h.commit()
    }
    expect(h.depth()).toBe(3)
  })
})
