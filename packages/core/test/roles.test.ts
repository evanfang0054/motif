import { describe, expect, it } from 'vitest'
import { roleAtLeast } from '../src/roles'

describe('角色层级（user < admin < root）', () => {
  it('同级满足要求', () => {
    expect(roleAtLeast('user', 'user')).toBe(true)
    expect(roleAtLeast('admin', 'admin')).toBe(true)
    expect(roleAtLeast('root', 'root')).toBe(true)
  })

  it('高一级满足低要求', () => {
    expect(roleAtLeast('admin', 'user')).toBe(true)
    expect(roleAtLeast('root', 'user')).toBe(true)
    expect(roleAtLeast('root', 'admin')).toBe(true)
  })

  it('低一级不满足高要求', () => {
    expect(roleAtLeast('user', 'admin')).toBe(false)
    expect(roleAtLeast('user', 'root')).toBe(false)
    expect(roleAtLeast('admin', 'root')).toBe(false)
  })
})
