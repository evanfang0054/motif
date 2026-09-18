import { describe, expect, it } from 'vitest'
import { clampPage, offsetFor, pageCount } from '@/lib/pagination'

describe('分页数学', () => {
  it('总页数按上取整；0 条算 1 页', () => {
    expect(pageCount(0, 20)).toBe(1)
    expect(pageCount(1, 20)).toBe(1)
    expect(pageCount(20, 20)).toBe(1)
    expect(pageCount(21, 20)).toBe(2)
    expect(pageCount(40, 20)).toBe(2)
    expect(pageCount(41, 20)).toBe(3)
  })

  it('非法输入不产出 NaN / Infinity 页数', () => {
    expect(pageCount(Number.NaN, 20)).toBe(1)
    expect(pageCount(-5, 20)).toBe(1)
    expect(pageCount(10, 0)).toBe(1)
    expect(pageCount(10, -1)).toBe(1)
    expect(pageCount(Number.POSITIVE_INFINITY, 20)).toBe(1)
  })

  it('页码越界被夹回：筛选后数据变少时不会停在空白页', () => {
    expect(clampPage(3, 5, 20)).toBe(1) // 只剩 5 条 → 只有 1 页
    expect(clampPage(2, 25, 20)).toBe(2) // 25 条 → 2 页，第 2 页合法
    expect(clampPage(9, 25, 20)).toBe(2) // 越界 → 夹到最后一页
    expect(clampPage(0, 25, 20)).toBe(1)
    expect(clampPage(-3, 25, 20)).toBe(1)
    expect(clampPage(Number.NaN, 25, 20)).toBe(1)
    expect(clampPage(1.7, 100, 20)).toBe(1) // 取整
  })

  it('offset 与服务端 page/pageSize 口径一致', () => {
    expect(offsetFor(1, 20)).toBe(0)
    expect(offsetFor(2, 20)).toBe(20)
    expect(offsetFor(3, 6)).toBe(12)
    expect(offsetFor(0, 20)).toBe(0)
    expect(offsetFor(Number.NaN, 20)).toBe(0)
  })
})
