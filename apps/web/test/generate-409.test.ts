import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NextRequest } from 'next/server'
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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'motif-409-'))
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

describe('同任务互斥 409（C4 / L4-4-G3-A1）', () => {
  for (const status of ['pending', 'running', 'canceling'] as const) {
    it(`topic.status=${status} 时返回 409，且不产生 generation_charge 流水`, async () => {
      store.setTopicActive(topicId, null, null, status)
      const before = chargeRows()
      const res = await POST(req(token, {
        prompt: '一只猫', count: 4, size: '1024x1024', enhance: false,
        topicId, referenceCanvasImageIds: [],
      }))
      expect(res.status).toBe(409)
      expect(chargeRows()).toBe(before) // 一分钱没扣
      expect(store.getUserById(userId)!.credits).toBe(50) // 余额不变
    })
  }

  it('topic.status=idle 时正常入队（对照组，证明上面的 409 不是「永远 409」）', async () => {
    const res = await POST(req(token, {
      prompt: '一只猫', count: 4, size: '1024x1024', enhance: false,
      topicId, referenceCanvasImageIds: [],
    }))
    expect(res.status).toBe(202)
    expect(chargeRows()).toBe(1)
  })
})
