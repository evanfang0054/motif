import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NextRequest } from 'next/server'
import { MotifStore } from '@motif/db'
import { SESSION_COOKIE } from '@/server/auth'
import { GET as settingsGET, POST as settingsPOST } from '@/app/api/admin/settings/route'
import { POST as dangerPOST } from '@/app/api/admin/settings/danger/route'

let dir: string
let store: MotifStore

function reqWith(token: string | undefined, body?: unknown): NextRequest {
  return {
    cookies: { get: (n: string) => (n === SESSION_COOKIE && token ? { value: token } : undefined) },
    json: async () => body,
  } as unknown as NextRequest
}

function sessionFor(role: 'user' | 'admin' | 'root', email: string): string {
  const u = store.createUser({ email, passwordHash: 'h', name: email, role })
  return store.createSession(u.id, 60_000)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'motif-settings-api-'))
  store = new MotifStore(join(dir, 't.db'))
  const g = globalThis as unknown as { __motifRuntime?: unknown }
  g.__motifRuntime = { store } as never
})

afterEach(() => {
  const g = globalThis as unknown as { __motifRuntime?: unknown }
  delete g.__motifRuntime
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('GET /api/admin/settings（root 独占）', () => {
  it('未登录 401 / 普通用户 403 / 管理员 403 / 超级管理员 200', async () => {
    expect((await settingsGET(reqWith(undefined))).status).toBe(401)
    expect((await settingsGET(reqWith(sessionFor('user', 'u@b.co')))).status).toBe(403)
    expect((await settingsGET(reqWith(sessionFor('admin', 'a@b.co')))).status).toBe(403)
    expect((await settingsGET(reqWith(sessionFor('root', 'r@b.co')))).status).toBe(200)
  })

  it('响应体里不出现任何密钥明文（按整个响应体断言，而不是只看某个字段）', async () => {
    const secret = 'sk-live-DO-NOT-LEAK-9f3a2b'
    store.setSetting('IMAGE_API_KEY', secret)
    store.setSetting('SMTP_PASS', 'qq-auth-code-abcdefg')
    // 正对照：同一条响应里必须**有**可读的非密钥值，否则「不含密钥」可能只是因为响应是空的
    store.setSetting('IMAGE_MODEL', 'gpt-image-2')
    const text = await (await settingsGET(reqWith(sessionFor('root', 'r2@b.co')))).text()
    expect(text).not.toContain(secret)
    expect(text).not.toContain('qq-auth-code-abcdefg')
    expect(text).toContain('gpt-image-2')
  })

  it('密钥项只回掩码与已设置标记', async () => {
    store.setSetting('IMAGE_API_KEY', 'sk-1234567890abcdef')
    const body = (await (await settingsGET(reqWith(sessionFor('root', 'r4@b.co')))).json()) as {
      items: Array<{ key: string; value: string | null; masked: string | null; isSet: boolean }>
    }
    const item = body.items.find((i) => i.key === 'IMAGE_API_KEY')!
    expect(item.value).toBeNull()
    expect(item.masked).toBe('sk-••••••••••••cdef')
    expect(item.isSet).toBe(true)
  })

  it('返回配置健康状态', async () => {
    const body = (await (await settingsGET(reqWith(sessionFor('root', 'r5@b.co')))).json()) as {
      health: Array<{ group: string; ready: boolean; reason: string | null }>
    }
    expect(body.health.find((h) => h.group === 'generation')!.ready).toBe(false)
  })

  it('数据位置项以只读形式返回（页面据此渲染为不可编辑）', async () => {
    const body = (await (await settingsGET(reqWith(sessionFor('root', 'r6@b.co')))).json()) as {
      items: Array<{ key: string; readOnly: boolean }>
    }
    expect(body.items.filter((i) => i.readOnly).map((i) => i.key).sort()).toEqual(['MOTIF_DATA_DIR', 'MOTIF_DB_FILE'])
  })
})

describe('POST /api/admin/settings（普通配置）', () => {
  it('未登录 401 / 管理员 403', async () => {
    expect((await settingsPOST(reqWith(undefined, { updates: {} }))).status).toBe(401)
    expect((await settingsPOST(reqWith(sessionFor('admin', 'a2@b.co'), { updates: {} }))).status).toBe(403)
  })

  it('保存合法配置返回 200 并落库', async () => {
    const token = sessionFor('root', 'r7@b.co')
    const res = await settingsPOST(reqWith(token, { updates: { IMAGE_MODEL: 'gpt-image-3' } }))
    expect(res.status).toBe(200)
    expect(store.getSetting('IMAGE_MODEL')).toBe('gpt-image-3')
  })

  it('数据位置写入被拒 400，且库中不留痕', async () => {
    const res = await settingsPOST(reqWith(sessionFor('root', 'r8@b.co'), { updates: { MOTIF_DATA_DIR: '/elsewhere' } }))
    expect(res.status).toBe(400)
    expect(store.getSetting('MOTIF_DATA_DIR')).toBeNull()
  })

  it('危险区键混进普通保存被拒 400（即使带了 confirm）', async () => {
    const res = await settingsPOST(
      reqWith(sessionFor('root', 'r9@b.co'), { updates: { PAYMENT_CHANNEL: 'epay' }, confirm: true })
    )
    expect(res.status).toBe(400)
    expect(store.getSetting('PAYMENT_CHANNEL')).toBeNull()
  })

  it('保存成功写入审计，且审计详情不含密钥值', async () => {
    const secret = 'sk-audit-must-not-contain-me'
    const token = sessionFor('root', 'r10@b.co')
    await settingsPOST(reqWith(token, { updates: { IMAGE_API_KEY: secret } }))
    const rows = store.listAuditPaged({ limit: 10, offset: 0 })
    const row = rows.find((r) => r.action === 'settings.update')!
    expect(row).toBeTruthy()
    expect(row.detail ?? '').toContain('IMAGE_API_KEY') // 键名要留痕
    expect(row.detail ?? '').not.toContain(secret) // 值绝不能留痕
  })
})

describe('POST /api/admin/settings/danger（危险区）', () => {
  it('缺少二次确认参数被拒 400，且库中不留痕', async () => {
    const res = await dangerPOST(reqWith(sessionFor('root', 'r11@b.co'), { updates: { PAYMENT_CHANNEL: 'epay' } }))
    expect(res.status).toBe(400)
    expect(store.getSetting('PAYMENT_CHANNEL')).toBeNull()
  })

  it('confirm 为假值时同样被拒（不能用 0 / "true" 蒙混）', async () => {
    // ⚠️ session 必须在循环外建：users.email 是 UNIQUE，循环里重复 createUser 会先抛
    // SqliteError: UNIQUE constraint failed —— 测试会在任何断言之前就红掉
    const token = sessionFor('root', 'r12@b.co')
    for (const bad of [false, 0, 'true', 1]) {
      const res = await dangerPOST(reqWith(token, { updates: { PAYMENT_CHANNEL: 'epay' }, confirm: bad }))
      expect(res.status).toBe(400)
    }
    expect(store.getSetting('PAYMENT_CHANNEL')).toBeNull()
  })

  it('带确认时成功并写入审计', async () => {
    const res = await dangerPOST(
      reqWith(sessionFor('root', 'r13@b.co'), { updates: { PAYMENT_CHANNEL: 'epay' }, confirm: true })
    )
    expect(res.status).toBe(200)
    expect(store.getSetting('PAYMENT_CHANNEL')).toBe('epay')
    expect(store.listAuditPaged({ limit: 10, offset: 0 }).some((r) => r.action === 'settings.update')).toBe(true)
  })

  it('普通键混进危险区入口被拒 400', async () => {
    const res = await dangerPOST(reqWith(sessionFor('root', 'r14@b.co'), { updates: { IMAGE_MODEL: 'x' }, confirm: true }))
    expect(res.status).toBe(400)
  })

  it('管理员访问危险区入口 403', async () => {
    expect((await dangerPOST(reqWith(sessionFor('admin', 'a3@b.co'), { updates: {}, confirm: true }))).status).toBe(403)
  })
})
