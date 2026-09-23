import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NextRequest } from 'next/server'
import { MotifStore } from '@motif/db'
import { hashPassword, verifyPassword, SESSION_COOKIE } from '@/server/auth'
import { POST } from '@/app/api/auth/change-password/route'

let dir: string
let store: MotifStore

/** 桩出路由真实读取的两处：cookies.get（会话解析 + 吊销保留当前）与 json（请求体） */
function jsonReq(body: unknown, token: string): NextRequest {
  return {
    cookies: { get: (name: string) => (name === SESSION_COOKIE ? { value: token } : undefined) },
    json: async () => body,
  } as unknown as NextRequest
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'motif-chpwd-'))
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

describe('改密后清除强制改密标记', () => {
  it('改密成功后 mustChangePassword 变 false', async () => {
    const u = store.createUser({
      email: 'cp@b.co',
      passwordHash: hashPassword('old12345'),
      name: 'cp',
      mustChangePassword: true,
    })
    const token = store.createSession(u.id, 60_000)
    expect(store.getUserById(u.id)!.mustChangePassword).toBe(true)

    // 字段名与真实路由一致：{ oldPassword, newPassword }
    const res = await POST(jsonReq({ oldPassword: 'old12345', newPassword: 'New12345!' }, token))
    expect(res.status).toBe(200)
    expect(store.getUserById(u.id)!.mustChangePassword).toBe(false)
  })

  it('弱新密码被拒（与注册同一套复杂度规则），且不改动原密码', async () => {
    const u = store.createUser({
      email: 'weak@b.co',
      passwordHash: hashPassword('old12345'),
      name: 'weak',
    })
    const token = store.createSession(u.id, 60_000)

    // `12345678` 长度够但没有大小写与符号 —— D14 之前它能过
    const res = await POST(jsonReq({ oldPassword: 'old12345', newPassword: '12345678' }, token))
    expect(res.status).toBe(400)
    // 原密码仍然可用：校验失败发生在写库之前
    const stored = store.getPasswordHash(u.id)!
    expect(verifyPassword('old12345', stored)).toBe(true)
    expect(verifyPassword('12345678', stored)).toBe(false)
  })
})
