import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NextRequest } from 'next/server'
import { MotifStore, type AdminLogRow } from '@motif/db'
import { SESSION_COOKIE } from '@/server/auth'
import { GET as logsGET } from '@/app/api/admin/logs/route'
import { POST as cleanupPOST } from '@/app/api/admin/logs/cleanup/route'

let dir: string
let store: MotifStore

function req(token: string | undefined, body?: unknown, query = ''): NextRequest {
  return {
    cookies: { get: (n: string) => (n === SESSION_COOKIE && token ? { value: token } : undefined) },
    json: async () => body,
    nextUrl: new URL(`http://localhost:3100/api/admin/logs${query}`),
  } as unknown as NextRequest
}

function sessionFor(role: 'user' | 'admin' | 'root', email: string): string {
  const u = store.createUser({ email, passwordHash: 'h', name: email, role })
  return store.createSession(u.id, 60_000)
}

/** 造一轮超期的已终态旧日志，返回其 id */
function seedOldCompleted(userId: string, topicId: string): string {
  const m = store.createMessage({ topicId, userId, prompt: '旧提示词', finalPrompt: '旧最终提示词', size: '1:1', requestedCount: 1, enhancePrompt: false, referenceIds: [] })
  store.setMessageStatus(m.id, 'completed')
  store.db.prepare("UPDATE messages SET created_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(m.id)
  return m.id
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'motif-admin-logs-'))
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

describe('访问控制', () => {
  it('未登录 401 / 普通用户 403 / 管理员 200', async () => {
    expect((await logsGET(req(undefined))).status).toBe(401)
    expect((await logsGET(req(sessionFor('user', 'u@b.co')))).status).toBe(403)
    expect((await logsGET(req(sessionFor('admin', 'a@b.co')))).status).toBe(200)
  })
})

describe('GET /api/admin/logs（跨用户视图）', () => {
  it('跨用户返回且含 prompt / finalPrompt 原文，倒序分页', async () => {
    const u1 = store.createUser({ email: 'l1@b.co', passwordHash: 'h', name: '甲' })
    const u2 = store.createUser({ email: 'l2@b.co', passwordHash: 'h', name: '乙' })
    const t1 = store.createTopic(u1.id, 't1')
    const t2 = store.createTopic(u2.id, 't2')
    store.createMessage({ topicId: t1.id, userId: u1.id, prompt: '甲说', finalPrompt: '甲发', size: '1:1', requestedCount: 1, enhancePrompt: true, referenceIds: [] })
    store.createMessage({ topicId: t2.id, userId: u2.id, prompt: '乙说', finalPrompt: '乙发', size: '1:1', requestedCount: 1, enhancePrompt: true, referenceIds: [] })
    const t = sessionFor('admin', 'a2@b.co')

    const body = (await (await logsGET(req(t))).json()) as { items: AdminLogRow[]; total: number }
    expect(body.total).toBe(2)
    expect(new Set(body.items.map((r) => r.userId)).size).toBe(2)
    expect(body.items[0].prompt).toBe('乙说')
    expect(body.items[0].finalPrompt).toBe('乙发')

    const byUser = {
      cookies: { get: (n: string) => (n === SESSION_COOKIE ? { value: t } : undefined) },
      nextUrl: new URL(`http://localhost:3100/api/admin/logs?userId=${u1.id}`),
    } as unknown as NextRequest
    expect(((await (await logsGET(byUser)).json()) as { total: number }).total).toBe(1)
  })
})

describe('POST /api/admin/logs/cleanup', () => {
  it('缺 confirm 一律 400 且一条都不删', async () => {
    const u = store.createUser({ email: 'l3@b.co', passwordHash: 'h', name: 'x' })
    const t = store.createTopic(u.id, 't')
    seedOldCompleted(u.id, t.id)
    const admin = sessionFor('admin', 'a3@b.co')

    expect((await cleanupPOST(req(admin, { days: 3650 }))).status).toBe(400)
    expect((await cleanupPOST(req(admin, { days: 3650, confirm: false }))).status).toBe(400)
    expect(store.countAllMessages({})).toBe(1)
    expect(store.listAudit({}).filter((r) => r.action === 'logs.cleanup')).toHaveLength(0)
  })

  it('days 越界/非整数一律 400', async () => {
    const admin = sessionFor('admin', 'a4@b.co')
    expect((await cleanupPOST(req(admin, { days: 0, confirm: true }))).status).toBe(400)
    expect((await cleanupPOST(req(admin, { days: 3651, confirm: true }))).status).toBe(400)
    expect((await cleanupPOST(req(admin, { days: 1.5, confirm: true }))).status).toBe(400)
  })

  it('带确认时删除超期终态、写审计含条数、且不动画布资产与流水', async () => {
    const u = store.createUser({ email: 'l4@b.co', passwordHash: 'h', name: 'x', credits: 20 })
    const t = store.createTopic(u.id, 't')
    const staleId = seedOldCompleted(u.id, t.id)
    store.insertCanvasImage({ topicId: t.id, userId: u.id, messageId: staleId, origin: 'generated', name: 'a.png', imageKey: 'k/a.png', mimeType: 'image/png', bytes: 1, width: 1, height: 1 })
    const fresh = store.createMessage({ topicId: t.id, userId: u.id, prompt: '新', finalPrompt: '新', size: '1:1', requestedCount: 1, enhancePrompt: false, referenceIds: [] })
    store.setMessageStatus(fresh.id, 'completed')

    const before = {
      images: (store.db.prepare('SELECT COUNT(*) AS c FROM canvas_images').get() as { c: number }).c,
      ledgerRows: (store.db.prepare('SELECT COUNT(*) AS c FROM credit_ledger').get() as { c: number }).c,
      credits: store.getUserById(u.id)!.credits,
    }
    const admin = sessionFor('admin', 'a5@b.co')
    // days: 1 → 阈值是「昨天」；种子日志的 created_at 是 2026-01-01，落在阈值之前，会被删
    const res = await cleanupPOST(req(admin, { days: 1, confirm: true }))
    expect(res.status).toBe(200)
    expect(((await res.json()) as { deleted: number }).deleted).toBe(1)

    expect(store.countAllMessages({})).toBe(1) // 未超期那条还在
    expect((store.db.prepare('SELECT COUNT(*) AS c FROM canvas_images').get() as { c: number }).c).toBe(before.images)
    expect((store.db.prepare('SELECT COUNT(*) AS c FROM credit_ledger').get() as { c: number }).c).toBe(before.ledgerRows)
    expect(store.getUserById(u.id)!.credits).toBe(before.credits)

    const audit = store.listAudit({}).filter((r) => r.action === 'logs.cleanup')
    expect(audit).toHaveLength(1)
    expect(audit[0].detail).toContain('"deleted":1')
  })
})
