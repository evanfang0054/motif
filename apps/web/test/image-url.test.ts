import { describe, expect, it } from 'vitest'
import { normalizePublicBase, withPublicImageBase } from '@/server/image-url'

/**
 * #57：把返回给前端的图片 `src` 换成对象存储直链。
 *
 * 这是「配了才生效、不配则与从前逐字一致」的开关型改动 ——
 * 所以每条都要有**未配时的对照断言**（否则「配了生效」可能是恒真的）。
 */

// ---------- #57：src 重写 ----------

describe('#57 withPublicImageBase：未配时零行为差异，配了才换直链', () => {
  const images = () => [{ src: '/api/canvas-images/c1', imageKey: 'users/u1/topics/t1/a.png' }]

  it('未配（undefined / null / 空串 / 纯空白）→ 返回**同一个数组引用**（不是内容相同的新数组）', () => {
    for (const base of [undefined, null, '', '   ']) {
      const input = images()
      expect(withPublicImageBase(input, base), String(base)).toBe(input)
    }
  })

  it('配了 → src 换成 `${base}/${imageKey}`', () => {
    expect(withPublicImageBase(images(), 'https://cdn.example.com')[0].src).toBe(
      'https://cdn.example.com/users/u1/topics/t1/a.png'
    )
  })

  it('尾部斜杠 / 两侧空白都不会拼出双斜杠', () => {
    expect(withPublicImageBase(images(), '  https://cdn.example.com///  ')[0].src).toBe(
      'https://cdn.example.com/users/u1/topics/t1/a.png'
    )
  })

  it('只改 src：其它字段原样，且**不改动原对象**', () => {
    const input = [{ src: '/api/canvas-images/c1', imageKey: 'k/a.png', name: 'a.png', bytes: 12 }]
    const out = withPublicImageBase(input, 'https://x.io')
    expect(out[0]).toEqual({ src: 'https://x.io/k/a.png', imageKey: 'k/a.png', name: 'a.png', bytes: 12 })
    expect(input[0].src).toBe('/api/canvas-images/c1')
  })

  it('反证：base 非空时必须**真的**重写（否则上面那条 toBe 会假绿）', () => {
    expect(withPublicImageBase(images(), 'https://x.io')[0].src).not.toBe('/api/canvas-images/c1')
  })

  it('normalizePublicBase：空 / 空白 / undefined → null；只去尾斜杠', () => {
    expect(normalizePublicBase(undefined)).toBeNull()
    expect(normalizePublicBase('   ')).toBeNull()
    expect(normalizePublicBase('https://x.io/')).toBe('https://x.io')
    expect(normalizePublicBase('https://x.io')).toBe('https://x.io')
  })
})
