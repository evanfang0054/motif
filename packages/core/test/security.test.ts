import { describe, expect, it } from 'vitest'
import { generateStrongPassword } from '../src/security'

describe('随机强密码生成', () => {
  it('默认长度不低于 20', () => {
    expect(generateStrongPassword().length).toBeGreaterThanOrEqual(20)
  })

  it('含大写、小写、数字、符号四类字符', () => {
    for (let i = 0; i < 50; i++) {
      const p = generateStrongPassword()
      expect(p).toMatch(/[A-Z]/)
      expect(p).toMatch(/[a-z]/)
      expect(p).toMatch(/[0-9]/)
      expect(p).toMatch(/[!@#$%^&*\-_=+]/)
    }
  })

  it('尊重自定义长度', () => {
    expect(generateStrongPassword(32).length).toBe(32)
    expect(generateStrongPassword(8).length).toBe(8)
  })

  it('不同调用产出不同密码（不退化）', () => {
    const set = new Set(Array.from({ length: 200 }, () => generateStrongPassword()))
    expect(set.size).toBe(200)
  })

  it('首位字符类别不固定（已洗牌）', () => {
    const heads = new Set(Array.from({ length: 100 }, () => generateStrongPassword()[0]))
    expect(heads.size).toBeGreaterThan(1)
  })
})
