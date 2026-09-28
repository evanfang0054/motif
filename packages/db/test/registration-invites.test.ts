import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newRegistrationCode } from '@motif/core'
import { MotifStore } from '../src/index'

let dir: string
let store: MotifStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'motif-reg-invite-'))
  store = new MotifStore(join(dir, 't.db'))
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

const user = (email: string, name = 'A') => ({ email, passwordHash: 'h', name })

describe('注册准入码：存储层', () => {
  it('核销成功时 used_by / used_at 落库，且等于新建用户的 id', () => {
    store.createRegistrationInvite({ code: 'AAAA1111', createdBy: 'usr_root' })
    const u = store.createUserWithRegistrationCode(user('a@example.com'), 'AAAA1111')
    expect(u).not.toBeNull()
    const [row] = store.listRegistrationInvites({})
    expect(row.usedBy).toBe(u!.id)
    expect(row.usedAt).toBeTruthy()
    expect(row.createdBy).toBe('usr_root')
  })

  it('同码二次核销失败 → 先插入的用户行被整体回滚（「同一事务」的真正证据）', () => {
    store.createRegistrationInvite({ code: 'CCCC3333' })
    const first = store.createUserWithRegistrationCode(user('a@example.com'), 'CCCC3333')
    expect(first).not.toBeNull()
    const second = store.createUserWithRegistrationCode(user('b@example.com', 'B'), 'CCCC3333')
    expect(second).toBeNull()
    // 关键：第二次调用里 createUser 已经 INSERT 成功，但条件 UPDATE 失败 ⇒ 整事务回滚
    expect(store.getUserByEmail('b@example.com')).toBeNull()
    expect(store.getUserByEmail('a@example.com')).not.toBeNull()
  })

  it('邮箱冲突时准入码不被消耗（createUser 先抛，条件 UPDATE 根本没执行）', () => {
    store.createUser(user('dup@example.com'))
    store.createRegistrationInvite({ code: 'DDDD4444' })
    expect(() => store.createUserWithRegistrationCode(user('dup@example.com', 'B'), 'DDDD4444')).toThrow()
    expect(store.listRegistrationInvites({})[0].usedBy).toBeNull()
  })

  it('已作废 / 不存在的码都核销失败，且都不建号', () => {
    store.createRegistrationInvite({ code: 'DDDD4444' })
    expect(store.revokeRegistrationInvite('DDDD4444')).toBe(true)
    expect(store.createUserWithRegistrationCode(user('c@example.com', 'C'), 'DDDD4444')).toBeNull()
    expect(store.createUserWithRegistrationCode(user('d@example.com', 'D'), 'ZZZZ9999')).toBeNull()
    expect(store.getUserByEmail('c@example.com')).toBeNull()
    expect(store.getUserByEmail('d@example.com')).toBeNull()
  })

  it('isRegistrationCodeUsable：只读判定三种不可用原因，且**不改动**码的状态', () => {
    store.createRegistrationInvite({ code: 'USABLE0001' })
    store.createRegistrationInvite({ code: 'USED000001' })
    store.createRegistrationInvite({ code: 'REVOKED001' })
    store.createRegistrationInvite({ code: 'REVOKED002' })
    store.createUserWithRegistrationCode(user('used@example.com'), 'USED000001')
    store.revokeRegistrationInvite('REVOKED001')
    expect(store.isRegistrationCodeUsable('USABLE0001')).toBe(true)
    expect(store.isRegistrationCodeUsable('USED000001')).toBe(false)
    expect(store.isRegistrationCodeUsable('REVOKED001')).toBe(false)
    expect(store.isRegistrationCodeUsable('NOPE000001')).toBe(false)
    // 小写入参按大小写归一处理（与核销路径同一套 toUpperCase）
    expect(store.isRegistrationCodeUsable('usable0001')).toBe(true)
    // 只读：查完之后码仍然可用（没被顺手核销）
    expect(store.isRegistrationCodeUsable('USABLE0001')).toBe(true)
    expect(store.listRegistrationInvites({}).find((r) => r.code === 'USABLE0001')!.usedBy).toBeNull()
  })

  it('已核销的码不可再作废（作废只对未使用生效）', () => {
    store.createRegistrationInvite({ code: 'EEEE5555' })
    store.createUserWithRegistrationCode(user('e@example.com', 'E'), 'EEEE5555')
    expect(store.revokeRegistrationInvite('EEEE5555')).toBe(false)
  })

  it('批量创建互不重复，且写入时大小写归一', () => {
    const codes = store.createRegistrationInviteBatch({ count: 5 })
    expect(new Set(codes).size).toBe(5)
    expect(store.listRegistrationInvites({})).toHaveLength(5)
    store.createRegistrationInvite({ code: 'ffff6666' })
    expect(store.listRegistrationInvites({}).some((r) => r.code === 'FFFF6666')).toBe(true)
  })

  it('生成器形态与既有推荐码一致：10 位大写字母数字', () => {
    expect(newRegistrationCode()).toMatch(/^[0-9A-Z]{10}$/)
  })
})
