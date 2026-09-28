import { describe, expect, it } from 'vitest'
import { GROUP_ORDER, GROUP_TITLE } from '@/app/admin/settings/groups'
import { SETTING_DEFS } from '@/server/settings'

describe('系统设置分组顺序', () => {
  it('注册表里出现过的每个分组都在 GROUP_ORDER 里（漏一个就会整组不渲染）', () => {
    const used = new Set(SETTING_DEFS.map((d) => d.group))
    for (const g of used) {
      // danger 是单独追加的 Tab，刻意不在 GROUP_ORDER 里
      if (g === 'danger') continue
      expect(GROUP_ORDER).toContain(g)
    }
  })

  it('auth 排在 security 之前（认证与会话相邻）', () => {
    expect(GROUP_ORDER.indexOf('auth')).toBeGreaterThan(-1)
    expect(GROUP_ORDER.indexOf('auth')).toBeLessThan(GROUP_ORDER.indexOf('security'))
  })

  it('GROUP_TITLE 与 GROUP_ORDER 覆盖同一组分组（只差单独追加的 danger）', () => {
    expect(Object.keys(GROUP_TITLE).sort()).toEqual([...GROUP_ORDER, 'danger'].sort())
  })
})
