import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NextRequest } from 'next/server'
import { MAX_REFERENCE_IMAGES } from '@motif/core'
import { MotifStore } from '@motif/db'
import { SESSION_COOKIE } from '@/server/auth'
import { POST } from '@/app/api/generate-images/route'

let dir: string
let store: MotifStore
let token: string
let topicId: string
let userId: string

const provider = { name: 'stub', generate: async () => { throw new Error('不应触发生成') } }

function req(token: string | undefined, body: unknown): NextRequest {
  return {
    cookies: { get: (name: string) => (name === SESSION_COOKIE && token ? { value: token } : undefined) },
    json: async () => body,
  } as unknown as NextRequest
}

function chargeRows(): number {
  return (store.db.prepare("SELECT COUNT(*) AS c FROM credit_ledger WHERE source = 'generation_charge'").get() as { c: number }).c
}

/** 造 n 张属于当前任务与用户的画布图，返回其 id */
function seedCanvasImages(n: number): string[] {
  return Array.from({ length: n }, (_, i) =>
    store.insertCanvasImage({
      topicId, userId, messageId: null, origin: 'generated',
      name: `img-${i}`, imageKey: `k${i}`, mimeType: 'image/webp', bytes: 1, width: 1024, height: 1024,
    }).id
  )
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'motif-refcap-'))
  store = new MotifStore(join(dir, 't.db'))
  ;(globalThis as unknown as { __motifRuntime?: unknown }).__motifRuntime = { store, provider, dataDir: join(dir, 'data') }
  userId = store.createUser({ name: 'u', email: 'u@e.com', passwordHash: 'h', role: 'user', credits: 50 }).id
  token = store.createSession(userId, 60_000)
  topicId = store.createTopic(userId, '任务A').id
})
afterEach(() => {
  delete (globalThis as unknown as { __motifRuntime?: unknown }).__motifRuntime
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe(`参考图上限 ${MAX_REFERENCE_IMAGES} 张（服务端兜底）`, () => {
  it('恰好 5 张时正常入队（对照组：证明上限不是「一律拒绝」）', async () => {
    const ids = seedCanvasImages(MAX_REFERENCE_IMAGES)
    const res = await POST(req(token, {
      prompt: '一只猫', count: 1, size: '1024x1024', enhance: false, topicId,
      referenceCanvasImageIds: ids,
    }))
    expect(res.status).toBe(202)
  })

  it('6 张时 400，且不产生 generation_charge 流水、余额不变（不能先扣费再失败）', async () => {
    const ids = seedCanvasImages(MAX_REFERENCE_IMAGES + 1)
    const before = chargeRows()
    const res = await POST(req(token, {
      prompt: '一只猫', count: 1, size: '1024x1024', enhance: false, topicId,
      referenceCanvasImageIds: ids,
    }))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: expect.stringContaining(String(MAX_REFERENCE_IMAGES)) })
    expect(chargeRows()).toBe(before)
    expect(store.getUserById(userId)!.credits).toBe(50)
  })

  it('同一张图重复提交也按「条数」计入上限（重复 6 次 → 400）', async () => {
    const [id] = seedCanvasImages(1)
    const res = await POST(req(token, {
      prompt: '一只猫', count: 1, size: '1024x1024', enhance: false, topicId,
      referenceCanvasImageIds: Array.from({ length: MAX_REFERENCE_IMAGES + 1 }, () => id),
    }))
    expect(res.status).toBe(400)
  })
})
