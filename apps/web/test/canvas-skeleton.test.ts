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

/**
 * 字段缺失的兜底（线上回归）。
 *
 * 复现的崩溃：`TypeError: Cannot read properties of undefined (reading 'length')`
 * —— `slotPlan` 是 undefined 时，`m.slotPlan.length` 直接抛，`skeletons` 这个 `useMemo`
 * 在 Workspace 渲染期求值，于是**整个工作台白屏**（不只是少几个骨架）。
 *
 * 为什么服务端会少发这个字段：`slotPlan` 是 #88 新加的，客户端（静态资源）与服务端
 * （API）**可以版本错开** —— 滚动发布时新客户端配旧服务端，dev 下 `next dev` 持有的
 * runtime 单例也可能仍是旧模块（见仓库记忆「dev 单例持旧类实例」）。
 * 客户端**不能**假设对端一定发了新字段。
 *
 * 兜底语义不是新发明的：`slotPlan = []` 本来就有明确定义 —— 老消息没有计划时
 * 「不产出骨架、走现场分配」（见 `server/services.ts` 的 `executeMessage` 里 `msg.slotPlan[i]`
 * 取不到就回落 `allocateSlots` 的那处判断）。
 * 所以「缺失」与「空数组」等价，都归到「没有计划」，而不是新造第三种行为。
 */
describe('pendingSkeletonSlots：slotPlan 缺失 / 形状不对时不崩（线上回归）', () => {
  it('消息完全没有 slotPlan 字段 → 当作「没有计划」，不抛异常（复现的线上 TypeError）', () => {
    const legacy = { id: 'm1', status: 'running' } as unknown as SkeletonMessageSource
    expect(() => pendingSkeletonSlots([legacy], {})).not.toThrow()
    expect(pendingSkeletonSlots([legacy], {})).toHaveLength(0)
  })

  it('slotPlan 显式为 undefined / null → 同上（JSON 里字段可能被序列化成 null）', () => {
    const undef = { id: 'm1', status: 'queued', slotPlan: undefined } as unknown as SkeletonMessageSource
    const nul = { id: 'm2', status: 'queued', slotPlan: null } as unknown as SkeletonMessageSource
    expect(pendingSkeletonSlots([undef, nul], {})).toHaveLength(0)
  })

  it('slotPlan 不是数组（脏数据）→ 同样归到「没有计划」，且不影响同批其它消息', () => {
    // 服务端坏值不该让整批骨架消失：坏的那条按空处理，好的那条照常出骨架。
    const broken = { id: 'bad', status: 'running', slotPlan: '[]' } as unknown as SkeletonMessageSource
    const out = pendingSkeletonSlots([broken, msg('good', 'running', 2)], {})
    expect(out.map((s) => `${s.messageId}:${s.index}`)).toEqual(['good:0', 'good:1'])
  })

  it('缺失兜底与「空计划」等价 —— 已落库张数再多也不会出负数骨架', () => {
    const legacy = { id: 'm1', status: 'running' } as unknown as SkeletonMessageSource
    expect(pendingSkeletonSlots([legacy], { m1: 3 })).toHaveLength(0)
  })

  it('数组内坏元素被跳过，但**保留原下标**（序号不与真实批次位置脱节）', () => {
    // 「字段在、元素坏」与「字段缺失」是同一前提（不信对端形状）下的两种形态，故同一标准。
    // ⚠️ 断言 index === 1（不是 0）：位置由 `rect` 自己携带，`index`/`ordinal` 只用于 React key
    // 与读屏文案；保留原下标是为了让「正在生成第 N 张」的序号贴合真实批次位置。
    // （真正会被 filter 重编号弄坏的场景是「坏槽落在已产出区间之前」，见下一条用例。）
    const bad = {
      id: 'm1',
      status: 'running',
      slotPlan: [null, { x: 0, y: 0, w: 240, h: 240 }, { x: NaN, y: 0, w: 240, h: 240 }, { x: 0, y: 0, w: 0, h: 240 }],
    } as unknown as SkeletonMessageSource
    const out = pendingSkeletonSlots([bad], {})
    expect(out).toHaveLength(1)
    expect(out[0].index).toBe(1)
    expect(out[0].ordinal).toBe(2)
    expect(out[0].rect).toEqual({ x: 0, y: 0, w: 240, h: 240 })
  })

  it('坏槽落在已产出区间之前时，剩余槽一个都不能少（这条才是「保留原下标」的真正理由）', () => {
    // 已产出 1 张 ⇒ 从下标 1 开始找未产出槽。下标 0 的槽是坏的、本就不该渲染。
    // 若实现改成「先 filter 掉坏项再按下标取」，plan 变成 [good1, good2] 而 done 仍是 1，
    // 循环从新数组的 1 起 ⇒ 只剩 1 个骨架（good2），good1 被静默吃掉。
    const m = {
      id: 'm1',
      status: 'running',
      slotPlan: [null, { x: 10, y: 0, w: 240, h: 240 }, { x: 20, y: 0, w: 240, h: 240 }],
    } as unknown as SkeletonMessageSource
    const out = pendingSkeletonSlots([m], { m1: 1 })
    expect(out.map((s) => s.index)).toEqual([1, 2])
    expect(out.map((s) => s.rect.x)).toEqual([10, 20])
  })
})
