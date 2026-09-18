import { describe, expect, it } from 'vitest'
import { newCdkCode } from '../src/ids'

describe('CDK 码生成', () => {
  it('默认带 MOTIF- 前缀，整体为大写字母数字与连字符', () => {
    const c = newCdkCode()
    expect(c).toMatch(/^MOTIF-[0-9A-Z]+$/)
  })

  it('支持自定义前缀（会被转成大写）', () => {
    expect(newCdkCode('wx')).toMatch(/^WX-[0-9A-Z]+$/)
  })

  it('前缀为空串时不带连字符前缀段', () => {
    expect(newCdkCode('')).toMatch(/^[0-9A-Z]+$/)
  })

  it('2000 次生成无重复', () => {
    const set = new Set(Array.from({ length: 2000 }, () => newCdkCode()))
    expect(set.size).toBe(2000)
  })

  it('剔除易混字符（不含 I/O/L/0/1）', () => {
    for (let i = 0; i < 200; i++) {
      const body = newCdkCode().split('-').slice(1).join('')
      expect(body).not.toMatch(/[IOL01]/)
    }
  })
})
