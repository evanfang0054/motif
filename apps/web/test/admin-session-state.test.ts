import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MotifStore } from '@motif/db'
import { resolveAdminSessionState } from '@/server/admin-session'

/**
 * 管理面会话裁决（#75-3.4）。
 *
 * 这条守卫要同时满足两个方向相反的要求：
 *  - 会话**过期**的管理员要看到「登录已过期」引导，而不是 Next 默认英文 404；
 *  - 未登录 / 无效 token / 非管理员 一律 404，**不泄露管理面的存在性**。
 * 因此「过期」的判据只能是「sessions 表里还留着那一行且已过期」，而不是「token 无效」。
 */

let dir: string
let store: MotifStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'motif-admin-session-'))
  store = new MotifStore(join(dir, 't.db'))
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

function mk(role: 'user' | 'admin' | 'root', email: string, status?: 'disabled') {
  const u = store.createUser({ email, passwordHash: 'h', name: email, role })
  if (status === 'disabled') store.setUserStatus(u.id, 'disabled')
  return u
}

describe('resolveAdminSessionState', () => {
  it('无 token → 404（不泄露管理面存在性）', () => {
    expect(resolveAdminSessionState(store, undefined).kind).toBe('unauthorized')
    expect(resolveAdminSessionState(store, null).kind).toBe('unauthorized')
    expect(resolveAdminSessionState(store, '').kind).toBe('unauthorized')
  })

  it('未知 token → 404（探路者拿不到「过期」引导）', () => {
    expect(resolveAdminSessionState(store, 'random-garbage').kind).toBe('unauthorized')
  })

  it('有效会话的管理员 → ok', () => {
    const admin = mk('admin', 'a@b.co')
    const token = store.createSession(admin.id, 60_000)
    const state = resolveAdminSessionState(store, token)
    expect(state.kind).toBe('ok')
    if (state.kind === 'ok') expect(state.user.id).toBe(admin.id)
  })

  it('超级管理员同样放行', () => {
    const root = mk('root', 'r@b.co')
    const token = store.createSession(root.id, 60_000)
    expect(resolveAdminSessionState(store, token).kind).toBe('ok')
  })

  it('有效会话的普通用户 → 404（与「未登录」同一档，不暴露 /admin）', () => {
    const u = mk('user', 'u@b.co')
    const token = store.createSession(u.id, 60_000)
    expect(resolveAdminSessionState(store, token).kind).toBe('unauthorized')
  })

  it('会话已过期的管理员 → expired（给「登录已过期」引导）', () => {
    const admin = mk('admin', 'a2@b.co')
    const token = store.createSession(admin.id, -1000)
    expect(resolveAdminSessionState(store, token).kind).toBe('expired')
  })

  it('会话已过期的普通用户 → 仍是 404（不因过期而升级成引导）', () => {
    const u = mk('user', 'u2@b.co')
    const token = store.createSession(u.id, -1000)
    expect(resolveAdminSessionState(store, token).kind).toBe('unauthorized')
  })

  it('被禁用管理员的过期会话 → 404（禁用与过期同时成立时不引导）', () => {
    const admin = mk('admin', 'a3@b.co', 'disabled')
    const token = store.createSession(admin.id, -1000)
    expect(resolveAdminSessionState(store, token).kind).toBe('unauthorized')
  })

  it('被禁用管理员的有效会话 → 404（getUserBySession 已把禁用解析为 null）', () => {
    const admin = mk('admin', 'a4@b.co', 'disabled')
    const token = store.createSession(admin.id, 60_000)
    expect(resolveAdminSessionState(store, token).kind).toBe('unauthorized')
  })

  it('登出（会话行被删）后 → 404，而不是冒充「过期」', () => {
    const admin = mk('admin', 'a5@b.co')
    const token = store.createSession(admin.id, -1000)
    store.deleteSession(token)
    expect(resolveAdminSessionState(store, token).kind).toBe('unauthorized')
  })
})
