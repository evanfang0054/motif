import { describe, expect, it } from 'vitest'
import { pendingSkeletonSlots, type SkeletonMessageSource } from '@/lib/canvas/skeleton'

/** 造一条计划：N 个 240×240 的槽，坐标递增（只为断言数量与顺序，坐标值本身不参与判据） */
function plan(n: number) {
  return Array.from({ length: n }, (_, i) => ({ x: i * 280, y: 0, w: 240, h: 240 }))
}

function msg(id: string, status: string, count: number): SkeletonMessageSource {
  return { id, status, slotPlan: plan(count) }
}

describe('pendingSkeletonSlots（#88：骨架数 = 未产出张数）', () => {
  it('提交 4 张、一张未出 → 4 个骨架，序号 1..4', () => {
    const out = pendingSkeletonSlots([msg('m1', 'queued', 4)], {})
    expect(out).toHaveLength(4)
    expect(out.map((s) => s.index)).toEqual([0, 1, 2, 3])
    expect(out.map((s) => s.ordinal)).toEqual([1, 2, 3, 4])
    expect(out.every((s) => s.messageId === 'm1')).toBe(true)
  })

  it('已落库 k 张 → 只剩 N−k 个骨架（前 k 个槽已被图片填掉）', () => {
    const out = pendingSkeletonSlots([msg('m1', 'running', 4)], { m1: 1 })
    expect(out.map((s) => s.index)).toEqual([1, 2, 3])
    // 骨架坐标 = 计划里第 1..3 个槽（与出图落位同坐标，故就地填入不跳动）
    expect(out[0].rect).toEqual({ x: 280, y: 0, w: 240, h: 240 })
  })

  it('全部产出 → 0 个骨架', () => {
    expect(pendingSkeletonSlots([msg('m1', 'running', 4)], { m1: 4 })).toHaveLength(0)
  })

  it('终态（完成/失败/取消）一律不留骨架 —— 摘除数 = 退额数', () => {
    // 取消/失败的退额 = requestedCount − 已落库张数 = 4 − 1 = 3；
    // 摘掉的骨架也恰好是「取消前的那 3 个」，故「摘除数 = 退额数」。
    for (const status of ['completed', 'failed', 'canceled']) {
      expect(pendingSkeletonSlots([msg('m1', status, 4)], { m1: 1 })).toHaveLength(0)
    }
  })

  it('canceling（停止中）仍算活跃：在 worker 收尾前骨架不提前消失', () => {
    expect(pendingSkeletonSlots([msg('m1', 'canceling', 4)], { m1: 2 })).toHaveLength(2)
  })

  it('老消息没有计划（slotPlan 为空）→ 不产出骨架', () => {
    expect(pendingSkeletonSlots([msg('m1', 'running', 0)], {})).toHaveLength(0)
  })

  it('已落库张数多于计划长度时不出负数骨架（脏数据兜底）', () => {
    expect(pendingSkeletonSlots([msg('m1', 'running', 2)], { m1: 5 })).toHaveLength(0)
  })

  it('多轮并存时按消息顺序各自成组，不串位', () => {
    const out = pendingSkeletonSlots([msg('m1', 'running', 2), msg('m2', 'queued', 3)], { m1: 1 })
    expect(out.map((s) => `${s.messageId}:${s.index}`)).toEqual(['m1:1', 'm2:0', 'm2:1', 'm2:2'])
  })
})
