import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NextRequest } from 'next/server'
import { MotifStore } from '@motif/db'
import { SESSION_COOKIE } from '@/server/auth'
import { POST } from '@/app/api/messages/[id]/cancel/route'

/**
 * 取消接口的**终态守卫**（#81）。
 *
 * 取消是可重复调用的接口：对已落终态的轮次再点一次，必须幂等 —— 返回当前状态、
 * 不动任务状态。原实现无条件把任务置 `canceling`，而消息的 UPDATE 只匹配 `running`，
 * 于是消息不动、任务被卡在「正在停止生成」再也没有出口（线上实测卡死 2h45m）。
 */

let dir: string
let store: MotifStore
let token: string
let topicId: string
let userId: string

function req(token: string | undefined): NextRequest {
  return {
    cookies: { get: (name: string) => (name === SESSION_COOKIE && token ? { value: token } : undefined) },
  } as unknown as NextRequest
}

function params(id: string) {
  return { params: Promise.resolve({ id }) }
}

function ledgerRows(): number {
  return (store.db.prepare('SELECT COUNT(*) AS c FROM credit_ledger').get() as { c: number }).c
}

/** 建一条已入队的消息（扣额 + 话题同步为 pending）—— 与生产同一步 */
function enqueue(count = 2) {
  store.deductCredits(userId, count, { source: 'generation_charge' })
  const m = store.createMessage({
    topicId, userId, prompt: 'p', finalPrompt: 'p', size: 'auto', requestedCount: count, enhancePrompt: false,
  })
  store.syncTopicStatus(topicId, m.id, 'p', 'queued')
  return m
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'motif-cancel-'))
  store = new MotifStore(join(dir, 't.db'))
  ;(globalThis as unknown as { __motifRuntime?: unknown }).__motifRuntime = {
    store, provider: { name: 'stub', generate: async () => { throw new Error('不应触发生成') } }, dataDir: join(dir, 'data'),
  }
  userId = store.createUser({ name: 'u', email: 'u@e.com', passwordHash: 'h', role: 'user', credits: 10 }).id
  token = store.createSession(userId, 60_000)
  topicId = store.createTopic(userId, '任务A').id
})
afterEach(() => {
  delete (globalThis as unknown as { __motifRuntime?: unknown }).__motifRuntime
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('取消的终态守卫（幂等）', () => {
  for (const status of ['completed', 'failed', 'canceled'] as const) {
    it(`对 ${status} 的轮次取消：200 且任务状态不变（连调两次仍不变）`, async () => {
      const m = enqueue(2)
      store.leaseNextMessage('w1', 60_000)
      store.setMessageStatus(m.id, status)
      store.syncTopicStatus(topicId, null, null, status)
      expect(store.getTopic(topicId)?.status).toBe('idle')

      const creditsBefore = store.getUserById(userId)!.credits
      const ledgerBefore = ledgerRows()

      for (let i = 0; i < 2; i++) {
        const res = await POST(req(token), params(m.id))
        expect(res.status, `第 ${i + 1} 次`).toBe(200)
        const body = (await res.json()) as { ok: boolean; alreadySettled?: boolean }
        expect(body.ok).toBe(true)
        expect(store.getTopic(topicId)?.status, `第 ${i + 1} 次后`).toBe('idle')
        expect(store.getMessage(m.id)?.status).toBe(status)
      }
      // 终态路径不得产生任何流水、也不得动余额
      expect(store.getUserById(userId)!.credits).toBe(creditsBefore)
      expect(ledgerRows()).toBe(ledgerBefore)
    })
  }

  it('对已在 canceling 的轮次再取消：不误判成终态，任务保持 canceling', async () => {
    const m = enqueue(2)
    store.leaseNextMessage('w1', 60_000)
    store.setMessageStatus(m.id, 'canceling')
    store.setTopicActive(topicId, m.id, 'p', 'canceling')

    const res = await POST(req(token), params(m.id))
    expect(res.status).toBe(200)
    expect(store.getTopic(topicId)?.status).toBe('canceling')
    expect(store.getMessage(m.id)?.status).toBe('canceling')
  })

  it('运行中的轮次取消：任务转 canceling，且不立即退额（由 worker 收尾退）', async () => {
    const m = enqueue(3)
    store.leaseNextMessage('w1', 60_000)
    expect(store.getTopic(topicId)?.status).toBe('running')

    const res = await POST(req(token), params(m.id))
    expect(res.status).toBe(200)
    expect(store.getTopic(topicId)?.status).toBe('canceling')
    expect(store.getMessage(m.id)?.status).toBe('canceling')
    expect(store.getUserById(userId)!.credits).toBe(7) // 10 - 3，尚未退
  })

  it('排队中的轮次取消：整单退额、任务回 idle（既有行为不回归）', async () => {
    const m = enqueue(3)
    expect(store.getTopic(topicId)?.status).toBe('pending')

    const res = await POST(req(token), params(m.id))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { topic: { id: string; status: string } }
    // 回归点：原实现这里返回的是 `getTopic(消息id)`（恒为 null），现在返回真正的任务
    expect(body.topic.id).toBe(topicId)
    expect(body.topic.status).toBe('idle')
    expect(store.getUserById(userId)!.credits).toBe(10)
    expect(store.getMessage(m.id)?.status).toBe('canceled')

    const ov = store.overviewStats()
    expect(ov.credits.ledgerSum).toBe(ov.credits.balance)
  })

  it('非本人 / 不存在的消息：404', async () => {
    const other = store.createUser({ name: 'o', email: 'o@e.com', passwordHash: 'h', credits: 10 }).id
    const otherToken = store.createSession(other, 60_000)
    const m = enqueue(1)
    expect((await POST(req(otherToken), params(m.id))).status).toBe(404)
    expect((await POST(req(token), params('msg_nope'))).status).toBe(404)
  })
})

describe('读取自愈的出口（#81 的历史脏任务）', () => {
  it('卡在 canceling、活跃消息已失败的脏任务：读一次即回 idle，可再次提交', async () => {
    const m = enqueue(2)
    store.leaseNextMessage('w1', 60_000)
    // 造 #81 现场：消息落 failed，任务仍停在 canceling 且挂着那条消息
    store.setMessageStatus(m.id, 'failed', '网关 503')
    store.setTopicActive(topicId, m.id, 'p', 'canceling')

    expect(store.getTopic(topicId)?.status).toBe('idle')
    expect(store.getTopic(topicId)?.activeMessageId).toBeNull()

    // 出口的实质：任务不再卡在「正在停止生成」，且不再被 409 拦住
    const listed = store.listTopics(userId)
    expect(listed.find((t) => t.id === topicId)?.status).toBe('idle')
  })
})
