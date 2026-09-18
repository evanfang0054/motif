import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NextRequest } from 'next/server'
import { MotifStore, type AuditLogRow } from '@motif/db'
import { SESSION_COOKIE } from '@/server/auth'
import { GET as auditGET } from '@/app/api/admin/audit/route'

let dir: string
let store: MotifStore

function req(token: string | undefined, query = ''): NextRequest {
  return {
    cookies: { get: (n: string) => (n === SESSION_COOKIE && token ? { value: token } : undefined) },
    nextUrl: new URL(`http://localhost:3100/api/admin/audit${query}`),
  } as unknown as NextRequest
}

function sessionFor(role: 'user' | 'admin' | 'root', email: string): string {
  const u = store.createUser({ email, passwordHash: 'h', name: email, role })
  return store.createSession(u.id, 60_000)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'motif-admin-audit-'))
  store = new MotifStore(join(dir, 't.db'))
  const g = globalThis as unknown as { __motifRuntime?: { store: MotifStore } }
  g.__motifRuntime = { store } as never
})

afterEach(() => {
  const g = globalThis as unknown as { __motifRuntime?: unknown }
  delete g.__motifRuntime
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('GET /api/admin/audit（root 独占）', () => {
  it('未登录 401 / 普通用户 403 / 管理员也 403 / 超级管理员 200', async () => {
    expect((await auditGET(req(undefined))).status).toBe(401)
    expect((await auditGET(req(sessionFor('user', 'u@b.co')))).status).toBe(403)
    expect((await auditGET(req(sessionFor('admin', 'a@b.co')))).status).toBe(403) // admin 也不行，与用户列表形成对照
    expect((await auditGET(req(sessionFor('root', 'r@b.co')))).status).toBe(200)
  })

  it('查询得到管理动作，且 action 精确匹配（不被同前缀动作污染）', async () => {
    const actor = store.createUser({ email: 'act@b.co', passwordHash: 'h', name: '操作者' })
    store.insertAudit({ actorId: actor.id, action: 'credit.adjust', targetType: 'user', targetId: 'usr_x', detail: '{"delta":5}' })
    store.insertAudit({ actorId: actor.id, action: 'credit.adjust.rollback', targetType: 'user', targetId: 'usr_x' })
    const t = sessionFor('root', 'r2@b.co')

    const all = (await (await auditGET(req(t))).json()) as { items: AuditLogRow[]; total: number }
    expect(all.total).toBe(2)

    const exact = (await (await auditGET(req(t, '?action=credit.adjust'))).json()) as { items: AuditLogRow[]; total: number }
    expect(exact.total).toBe(1) // 前缀匹配会变成 2 → 必红
    expect(exact.items[0].action).toBe('credit.adjust')
    expect(exact.items[0].detail).toBe('{"delta":5}')

    const byActor = (await (await auditGET(req(t, `?actorId=${actor.id}`))).json()) as { total: number }
    expect(byActor.total).toBe(2)
  })

  it('分页生效且倒序', async () => {
    const actor = store.createUser({ email: 'act2@b.co', passwordHash: 'h', name: 'x' })
    for (let i = 1; i <= 3; i++) store.insertAudit({ actorId: actor.id, action: `test.act${i}` })
    const t = sessionFor('root', 'r3@b.co')

    const p1 = (await (await auditGET(req(t, '?pageSize=2'))).json()) as { items: AuditLogRow[]; total: number }
    expect(p1.total).toBe(3)
    expect(p1.items).toHaveLength(2)
    expect(p1.items[0].action).toBe('test.act3') // 倒序
    const p2 = (await (await auditGET(req(t, '?pageSize=2&page=2'))).json()) as { items: AuditLogRow[]; page: number }
    expect(p2.page).toBe(2)
    expect(p2.items).toHaveLength(1)
    expect(p2.items[0].action).toBe('test.act1')
  })
})
