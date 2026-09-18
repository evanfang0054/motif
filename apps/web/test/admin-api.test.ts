import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NextRequest } from 'next/server'
import { MotifStore } from '@motif/db'
import { SESSION_COOKIE } from '@/server/auth'
import { GET as overviewGET } from '@/app/api/admin/overview/route'
import { GET as settingsGET } from '@/app/api/admin/settings/route'

let dir: string
let store: MotifStore

function reqWithSession(token?: string): NextRequest {
  return {
    cookies: { get: (name: string) => (name === SESSION_COOKIE && token ? { value: token } : undefined) },
  } as unknown as NextRequest
}

function sessionFor(role: 'user' | 'admin' | 'root', email: string): string {
  const u = store.createUser({ email, passwordHash: 'h', name: email, role })
  return store.createSession(u.id, 60_000)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'motif-admin-api-'))
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

describe('GET /api/admin/overview（admin 级）', () => {
  it('未登录返回 401', async () => {
    expect((await overviewGET(reqWithSession())).status).toBe(401)
  })

  it('普通用户返回 403', async () => {
    expect((await overviewGET(reqWithSession(sessionFor('user', 'u@b.co')))).status).toBe(403)
  })

  it('管理员返回 200', async () => {
    expect((await overviewGET(reqWithSession(sessionFor('admin', 'a@b.co')))).status).toBe(200)
  })

  it('超级管理员返回 200', async () => {
    expect((await overviewGET(reqWithSession(sessionFor('root', 'r@b.co')))).status).toBe(200)
  })
})

describe('GET /api/admin/settings（root 级）', () => {
  it('未登录返回 401', async () => {
    expect((await settingsGET(reqWithSession())).status).toBe(401)
  })

  it('普通用户返回 403', async () => {
    expect((await settingsGET(reqWithSession(sessionFor('user', 'u2@b.co')))).status).toBe(403)
  })

  it('管理员返回 403（root 独占）', async () => {
    expect((await settingsGET(reqWithSession(sessionFor('admin', 'a2@b.co')))).status).toBe(403)
  })

  it('超级管理员返回 200', async () => {
    expect((await settingsGET(reqWithSession(sessionFor('root', 'r2@b.co')))).status).toBe(200)
  })
})
