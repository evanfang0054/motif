import { describe, expect, it } from 'vitest'
import { MAX_REFERENCE_IMAGES, planReferenceAdd, validateReferenceCount } from '../src/index'

describe('planReferenceAdd 逐张准入（单张与框选批量同一条规则）', () => {
  it('空列表时能加满 5 张', () => {
    const plan = planReferenceAdd([], ['a', 'b', 'c', 'd', 'e'])
    expect(plan.accepted).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(plan.alreadyReferenced).toEqual([])
    expect(plan.rejected).toEqual([])
  })

  it('已有 4 张时，再框选 3 张 → 只准入 1 张（靠前的先进，不是整批失败）', () => {
    const plan = planReferenceAdd(['r1', 'r2', 'r3', 'r4'], ['c1', 'c2', 'c3'])
    expect(plan.accepted).toEqual(['c1'])
    expect(plan.rejected).toEqual(['c2', 'c3'])
    expect(plan.alreadyReferenced).toEqual([])
  })

  it('已达 5 张时，全部被拒', () => {
    const plan = planReferenceAdd(['r1', 'r2', 'r3', 'r4', 'r5'], ['c1', 'c2'])
    expect(plan.accepted).toEqual([])
    expect(plan.rejected).toEqual(['c1', 'c2'])
  })

  it('已在列表里的跳过（不占名额、也不计入「被拒」）', () => {
    const plan = planReferenceAdd(['r1', 'r2', 'r3', 'r4'], ['r2', 'c1', 'c2'])
    expect(plan.alreadyReferenced).toEqual(['r2'])
    expect(plan.accepted).toEqual(['c1'])
    expect(plan.rejected).toEqual(['c2'])
  })

  it('incoming 内部重复只算一张，第二次出现按「已在参考图里」处理', () => {
    const plan = planReferenceAdd([], ['c1', 'c1'])
    expect(plan.accepted).toEqual(['c1'])
    expect(plan.alreadyReferenced).toEqual(['c1'])
    expect(plan.rejected).toEqual([])
  })

  it('批量等价于逐张加：同一批分两次加与一次加，结果一致', () => {
    const once = planReferenceAdd([], ['a', 'b', 'c', 'd', 'e', 'f'])
    let ids: string[] = []
    const stepwise: string[] = []
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
      const p = planReferenceAdd(ids, [id])
      ids = [...ids, ...p.accepted]
      stepwise.push(...p.accepted)
    }
    expect(stepwise).toEqual(once.accepted)
    expect(ids).toHaveLength(MAX_REFERENCE_IMAGES)
  })

  it('max 可覆盖（默认 5）', () => {
    expect(planReferenceAdd([], ['a', 'b'], 1).accepted).toEqual(['a'])
    expect(planReferenceAdd([], ['a', 'b'], 0).rejected).toEqual(['a', 'b'])
  })
})

describe('validateReferenceCount', () => {
  it('0–5 合法，>5 报错并带出上限', () => {
    expect(validateReferenceCount(0)).toBeNull()
    expect(validateReferenceCount(5)).toBeNull()
    expect(validateReferenceCount(6)).toContain('5')
  })

  it('负数与非整数不合法', () => {
    expect(validateReferenceCount(-1)).not.toBeNull()
    expect(validateReferenceCount(1.5)).not.toBeNull()
    expect(validateReferenceCount(Number.NaN)).not.toBeNull()
  })
})
