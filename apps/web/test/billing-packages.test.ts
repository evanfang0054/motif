import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MotifStore } from '@motif/db'
import { yuanToFen } from '@/server/settings'
import { resolvePackages } from '@/server/services'

let dir: string
let store: MotifStore
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'motif-billing-pkg-'))
  store = new MotifStore(join(dir, 't.db'))
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('yuanToFen', () => {
  it('元字符串转分整数（含浮点噪声修正）', () => {
    expect(yuanToFen('68.00')).toBe(6800)
    expect(yuanToFen('68.5')).toBe(6850)
    expect(yuanToFen('68')).toBe(6800)
    expect(yuanToFen('0.1')).toBe(10)
    expect(yuanToFen('0.29')).toBe(29)
  })
  it('非法输入返回 null', () => {
    expect(yuanToFen('-1')).toBeNull()
    expect(yuanToFen('1.234')).toBeNull()
    expect(yuanToFen('100000')).toBeNull()
    expect(yuanToFen('')).toBeNull()
    expect(yuanToFen('abc')).toBeNull()
  })
})

describe('resolvePackages（配置优先，缺省回退）', () => {
  it('未配置时回退默认价 68/136/272/680 与 hkd', () => {
    const pkgs = resolvePackages(store, {})
    expect(pkgs.map((p) => p.amountTotal)).toEqual([6800, 13600, 27200, 68000])
    expect(pkgs[0].currency).toBe('hkd')
    expect(pkgs.map((p) => p.credits)).toEqual([50, 100, 200, 500])
  })

  it('配置后按配置出套餐（币种 cny + 自定义价）', () => {
    store.setSettings([
      { key: 'BILLING_CURRENCY', value: 'cny' },
      { key: 'PRICE_CREDITS_50', value: '39.90' },
    ])
    const pkgs = resolvePackages(store, {})
    expect(pkgs[0]).toMatchObject({ currency: 'cny', amountTotal: 3990 })
    expect(pkgs[1].amountTotal).toBe(13600) // 未配置的档回退默认
  })

  it('配置被清空（删除行）后回退默认 —— 不落空串遮蔽', () => {
    store.setSettings([{ key: 'PRICE_CREDITS_50', value: '39.90' }])
    store.deleteSettings(['PRICE_CREDITS_50'])
    expect(resolvePackages(store, {})[0].amountTotal).toBe(6800)
  })
})
