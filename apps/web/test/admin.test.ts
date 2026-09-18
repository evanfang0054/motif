import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NextRequest } from 'next/server'
import { MotifStore } from '@motif/db'
import type { User } from '@motif/core'
import { assertCanDisable, assertCanModifyRole, requireAdmin, requireRoot, writeAudit } from '@/server/admin'
import { SESSION_COOKIE } from '@/server/auth'
import { ServiceError } from '@/server/services'

let dir: string
let store: MotifStore

/** 只桩 cookies.get 的最小请求；admin.ts 只读这一处 */
function reqWithSession(token?: string): NextRequest {
  return {
    cookies: { get: (name: string) => (name === SESSION_COOKIE && token ? { value: token } : undefined) },
  } as unknown as NextRequest
}

/** 造一个已登录用户，返回其 User 与可用于请求的会话 token（createSession 返回明文） */
function actor(role: 'user' | 'admin' | 'root', email: string): { user: User; token: string } {
  const created = store.createUser({ email, passwordHash: 'h', name: email, role })
  const token = store.createSession(created.id, 60_000)
  return { user: store.getUserById(created.id)!, token }
}

/**
 * 断言调用抛指定状态码的 ServiceError。
 * 必须显式处理「没有抛错」的情况 —— 否则 catch 不执行、测试空转通过。
 */
function expectStatus(fn: () => unknown, status: number): void {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(ServiceError)
    expect((e as ServiceError).status).toBe(status)
    return
  }
  throw new Error(`期望抛出 ServiceError(${status})，但函数正常返回`)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'motif-admin-'))
  store = new MotifStore(join(dir, 't.db'))
  // getRuntime() 命中缓存则直接返回，不会构造 provider/mailer（故无需 IMAGE_API_*）
  const g = globalThis as unknown as { __motifRuntime?: { store: MotifStore } }
  g.__motifRuntime = { store } as never
})

afterEach(() => {
  const g = globalThis as unknown as { __motifRuntime?: unknown }
  delete g.__motifRuntime
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('管理面守卫', () => {
  it('未登录访问 admin 级接口得 401', () => {
    expectStatus(() => requireAdmin(reqWithSession()), 401)
  })

  it('普通用户访问 admin 级接口得 403', () => {
    const u = actor('user', 'u@b.co')
    expectStatus(() => requireAdmin(reqWithSession(u.token)), 403)
  })

  it('管理员访问 admin 级接口通过', () => {
    const a = actor('admin', 'a@b.co')
    expect(requireAdmin(reqWithSession(a.token)).id).toBe(a.user.id)
  })

  it('管理员访问 root 级接口得 403', () => {
    const a = actor('admin', 'a2@b.co')
    expectStatus(() => requireRoot(reqWithSession(a.token)), 403)
  })

  it('超级管理员访问 root 级接口通过', () => {
    const r = actor('root', 'r@b.co')
    expect(requireRoot(reqWithSession(r.token)).role).toBe('root')
  })

  it('被禁用的管理员即使角色够也拿不到权限', () => {
    const a = actor('admin', 'a3@b.co')
    store.setUserStatus(a.user.id, 'disabled')
    expectStatus(() => requireAdmin(reqWithSession(a.token)), 403)
  })

  it('无效 token 得 401', () => {
    expectStatus(() => requireAdmin(reqWithSession('not-a-real-token')), 401)
  })
})

describe('角色保护规则', () => {
  it('管理员不可修改超级管理员的角色', () => {
    const a = actor('admin', 'a4@b.co')
    const r = actor('root', 'r2@b.co')
    expectStatus(() => assertCanModifyRole(a.user, r.user, 'user'), 403)
  })

  it('管理员不可禁用超级管理员', () => {
    const a = actor('admin', 'a5@b.co')
    const r = actor('root', 'r3@b.co')
    expectStatus(() => assertCanDisable(a.user, r.user), 403)
  })

  it('存在两个 root 时可降级其一，降级后剩余 root 数量为 1', () => {
    const r1 = actor('root', 'r4@b.co')
    const r2 = actor('root', 'r5@b.co')
    expect(() => assertCanModifyRole(r2.user, r1.user, 'admin')).not.toThrow()
    store.updateUserRole(r1.user.id, 'admin')
    expect(store.countUsersByRole('root')).toBe(1)
  })

  it('最后一个超级管理员不可被降级', () => {
    const r = actor('root', 'r6@b.co')
    expectStatus(() => assertCanModifyRole(r.user, r.user, 'admin'), 403)
  })

  it('最后一个超级管理员不可被禁用', () => {
    const r = actor('root', 'r7@b.co')
    expectStatus(() => assertCanDisable(r.user, r.user), 403)
  })

  it('存在两个 root 时禁用其一被允许', () => {
    const r1 = actor('root', 'r8@b.co')
    const r2 = actor('root', 'r9@b.co')
    expect(() => assertCanDisable(r1.user, r2.user)).not.toThrow()
  })

  it('管理员可正常修改普通用户角色（不误触发 root 保护）', () => {
    const a = actor('admin', 'a6@b.co')
    const u = actor('user', 'u2@b.co')
    expect(() => assertCanModifyRole(a.user, u.user, 'admin')).not.toThrow()
  })

  it('管理员不可把普通用户提升为超级管理员（防架空最后 root 保护）', () => {
    const a = actor('admin', 'a8@b.co')
    const u = actor('user', 'u3@b.co')
    expectStatus(() => assertCanModifyRole(a.user, u.user, 'root'), 403)
  })

  it('超级管理员可把普通用户提升为超级管理员', () => {
    const r = actor('root', 'r10@b.co')
    const u = actor('user', 'u4@b.co')
    expect(() => assertCanModifyRole(r.user, u.user, 'root')).not.toThrow()
  })
})

describe('审计写入', () => {
  it('写入成功后可按操作者查回', () => {
    const a = actor('admin', 'a7@b.co')
    writeAudit({ actorId: a.user.id, action: 'credit.adjust', targetType: 'user', targetId: 'usr_x', detail: { delta: 5, reason: '补偿' } })
    const rows = store.listAudit({ actorId: a.user.id })
    expect(rows).toHaveLength(1)
    expect(rows[0].detail).toContain('补偿')
  })

  it('审计写入抛错时不向上冒泡（不阻断主操作）', () => {
    store.close() // 让 insertAudit 必然抛错
    expect(() => writeAudit({ actorId: 'usr_x', action: 'credit.adjust' })).not.toThrow()
  })
})
