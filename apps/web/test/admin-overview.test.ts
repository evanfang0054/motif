import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NextRequest } from 'next/server'
import { MotifStore, type AdminOverview } from '@motif/db'
import { SESSION_COOKIE } from '@/server/auth'
import { GET as overviewGET } from '@/app/api/admin/overview/route'

let dir: string
let store: MotifStore

function req(token?: string): NextRequest {
  return {
    cookies: { get: (n: string) => (n === SESSION_COOKIE && token ? { value: token } : undefined) },
  } as unknown as NextRequest
}

function sessionFor(role: 'user' | 'admin' | 'root', email: string): string {
  const u = store.createUser({ email, passwordHash: 'h', name: email, role })
  return store.createSession(u.id, 60_000)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'motif-admin-overview-'))
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

describe('GET /api/admin/overview', () => {
  it('未登录 401 / 普通用户 403 / 管理员 200', async () => {
    expect((await overviewGET(req(undefined))).status).toBe(401)
    expect((await overviewGET(req(sessionFor('user', 'u@b.co')))).status).toBe(403)
    expect((await overviewGET(req(sessionFor('admin', 'a@b.co')))).status).toBe(200)
  })

  it('超级管理员同样 200（不是 root 独占）', async () => {
    expect((await overviewGET(req(sessionFor('root', 'r@b.co')))).status).toBe(200)
  })

  it('返回六组指标且与库一致', async () => {
    store.createUser({ email: 'ov@b.co', passwordHash: 'h', name: 'x', credits: 7 })
    store.createCdk('OV-API-1', 9)
    const res = await overviewGET(req(sessionFor('admin', 'a2@b.co')))
    const body = (await res.json()) as AdminOverview
    // 上面那个用户 + 管理员自己（本例未建 root）
    expect(body.users.total).toBe(2)
    expect(body.credits.balance).toBe(7)
    expect(body.credits.ledgerSum).toBe(7) // 不变式在接口层同样成立
    expect(body.cdks.unredeemed).toBe(1)
    expect(body.feedback.pending).toBe(0)
    expect(Array.isArray(body.credits.bySource)).toBe(true)
    expect(body.credits.bySource.reduce((a, x) => a + x.net, 0)).toBe(7)
  })
})
