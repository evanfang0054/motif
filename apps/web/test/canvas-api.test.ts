import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NextRequest } from 'next/server'
import { MotifStore } from '@motif/db'
import { SESSION_COOKIE } from '@/server/auth'
import { GET, PATCH } from '@/app/api/topics/[id]/canvas/route'

let dir: string
let store: MotifStore
let token: string
let topicId: string
let userId: string

function req(token: string | undefined, body?: unknown): NextRequest {
  return {
    cookies: { get: (name: string) => (name === SESSION_COOKIE && token ? { value: token } : undefined) },
    json: async () => body,
  } as unknown as NextRequest
}
const params = (id: string) => ({ params: Promise.resolve({ id }) })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'motif-canvas-api-'))
  store = new MotifStore(join(dir, 't.db'))
  // 画布路由只读 store，故注入 { store } 即可（沿用 admin-api.test.ts 的注入方式）
  ;(globalThis as unknown as { __motifRuntime?: unknown }).__motifRuntime = { store }
  userId = store.createUser({ name: 'u', email: 'u@e.com', passwordHash: 'h', role: 'user' }).id
  token = store.createSession(userId, 60_000)
  topicId = store.createTopic(userId, '任务A').id
})
afterEach(() => {
  delete (globalThis as unknown as { __motifRuntime?: unknown }).__motifRuntime
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('GET /api/topics/[id]/canvas（L3-1-G1-A1）', () => {
  it('未登录 401', async () => {
    expect((await GET(req(undefined), params(topicId))).status).toBe(401)
  })

  it('他人的 topic 返回 404', async () => {
    const other = store.createUser({ name: 'x', email: 'x@e.com', passwordHash: 'h', role: 'user' })
    const otherTopic = store.createTopic(other.id, '别人的').id
    expect((await GET(req(token), params(otherTopic))).status).toBe(404)
  })
  it('返回 { images, meta } 且 meta 为默认值', async () => {
    const res = await GET(req(token), params(topicId))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ images: [], meta: { viewport: { x: 0, y: 0, k: 1 }, background: 'lines', version: 1 } })
  })
})

/** ⚠️ L3-1-G1-A3 在 spec 里的原话是「非法补丁整批回滚」。这里断言的是**可观测等价物**：
 * 400 + 零写入（SQLite 单事务下「整批不落库」与「回滚」对外不可区分），
 * 故标签写 A3 指的是该断言的接口侧落点。 */
describe('PATCH /api/topics/[id]/canvas（L3-1-G1-A2/A3）', () => {
  it('未登录 401', async () => {
    expect((await PATCH(req(undefined, { images: { upsert: [] } }), params(topicId))).status).toBe(401)
  })

  it('响应含 applied / rejected / meta 三键，且 meta 真的落库了', async () => {
    const img = store.insertCanvasImage({ topicId, userId, messageId: null, origin: 'generated', name: 'a', imageKey: 'k', mimeType: 'image/webp', bytes: 1, width: 1024, height: 1024 })
    const res = await PATCH(req(token, {
      images: { upsert: [{ id: img.id, canvasX: 10, canvasY: 20, canvasWidth: 240, canvasHeight: 240, updatedAt: '2026-09-20T10:00:00.000Z' }] },
      meta: { viewport: { x: 5, y: 6, k: 2 } },
    }), params(topicId))
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['applied', 'meta', 'rejected'])
    expect(body.applied).toEqual([img.id])
    expect(body.rejected).toEqual([])
    expect((body.meta as { viewport: { k: number } }).viewport.k).toBe(2)
    // 关键：读回库确认真的持久化了（只断言响应体会在 setCanvasMeta 被删掉时依然通过）
    expect(store.getCanvasMeta(topicId)).toEqual({ viewport: { x: 5, y: 6, k: 2 }, background: 'lines', version: 1 })
    // 位置也真的落库了
    expect(store.listCanvasPlacements(topicId)[0]).toMatchObject({ canvasX: 10, canvasY: 20 })
  })

  it('任一 upsert 非法时整批不落库（400 + 零写入）', async () => {
    const ok = store.insertCanvasImage({ topicId, userId, messageId: null, origin: 'generated', name: 'a', imageKey: 'k', mimeType: 'image/webp', bytes: 1, width: 1024, height: 1024 })
    const res = await PATCH(req(token, {
      images: {
        upsert: [
          { id: ok.id, canvasX: 10, canvasY: 20, canvasWidth: 240, canvasHeight: 240, updatedAt: '2026-09-20T10:00:00.000Z' },
          { id: 'cimg_bad', canvasX: Number.NaN, canvasY: 0, canvasWidth: 1, canvasHeight: 1, updatedAt: '2026-09-20T10:00:00.000Z' },
        ],
      },
    }), params(topicId))
    expect(res.status).toBe(400)
    // 合法那条也没写进去
    expect(store.listCanvasPlacements(topicId)[0].canvasX).toBe(0)
  })

  it('他人的 topic 返回 404 且不写入', async () => {
    const other = store.createUser({ name: 'x', email: 'x@e.com', passwordHash: 'h', role: 'user' })
    const otherTopic = store.createTopic(other.id, '别人的').id
    const res = await PATCH(req(token, { images: { upsert: [] } }), params(otherTopic))
    expect(res.status).toBe(404)
  })

  it('upsert 不是数组时 400（不是 500）', async () => {
    for (const bad of ['x', {}, 42]) {
      const res = await PATCH(req(token, { images: { upsert: bad } }), params(topicId))
      expect(res.status).toBe(400)
    }
  })

  it('updatedAt 为空白串时 400（空串是「待补位」哨兵，客户端不得用它落位）', async () => {
    const img = store.insertCanvasImage({ topicId, userId, messageId: null, origin: 'generated', name: 'a', imageKey: 'k', mimeType: 'image/webp', bytes: 1, width: 1024, height: 1024 })
    const res = await PATCH(req(token, {
      images: { upsert: [{ id: img.id, canvasX: 10, canvasY: 20, canvasWidth: 240, canvasHeight: 240, updatedAt: '' }] },
    }), params(topicId))
    expect(res.status).toBe(400)
    expect(store.listCanvasPlacements(topicId)[0].canvasX).toBe(0)
  })

  it('尺寸非正数时 400（0×0 的图既看不见、又占不住槽位）', async () => {
    const img = store.insertCanvasImage({ topicId, userId, messageId: null, origin: 'generated', name: 'a', imageKey: 'k', mimeType: 'image/webp', bytes: 1, width: 1024, height: 1024 })
    for (const bad of [0, -1]) {
      const res = await PATCH(req(token, {
        images: { upsert: [{ id: img.id, canvasX: 10, canvasY: 20, canvasWidth: bad, canvasHeight: 240, updatedAt: '2026-09-20T10:00:00.000Z' }] },
      }), params(topicId))
      expect(res.status).toBe(400)
    }
  })

  it('meta 里 k<=0 被归一为正的默认缩放，且之后的 GET 不会崩（画布仍可打开）', async () => {
    store.insertCanvasImage({ topicId, userId, messageId: null, origin: 'generated', name: 'a', imageKey: 'ka', mimeType: 'image/webp', bytes: 1, width: 1024, height: 1024 })
    const res = await PATCH(req(token, { meta: { viewport: { k: 0 } } }), params(topicId))
    expect(res.status).toBe(200)
    expect(((await res.json()) as { meta: { viewport: { k: number } } }).meta.viewport.k).toBe(1)
    // 关键：补位不能算出 NaN（NaN 写进 NOT NULL 列会抛错 → 之后每次 GET 都 500）
    const after = await GET(req(token), params(topicId))
    expect(after.status).toBe(200)
    const body = (await after.json()) as { images: Array<{ canvasX: number; canvasY: number }> }
    expect(body.images.every((p) => Number.isFinite(p.canvasX) && Number.isFinite(p.canvasY))).toBe(true)
  })

  it('补丁里带非空 delete 时 400（P1 删除走 DELETE /api/canvas-images/[id]，不静默丢弃）', async () => {
    const res = await PATCH(req(token, { images: { delete: ['cimg_a'] } }), params(topicId))
    expect(res.status).toBe(400)
  })
})

describe('旧库补位挂在 GET 上（L3-2-G1-A3）', () => {
  it('首次 GET 补位；连续两次 GET 位置不变', async () => {
    store.insertCanvasImage({ topicId, userId, messageId: null, origin: 'generated', name: 'a', imageKey: 'ka', mimeType: 'image/webp', bytes: 1, width: 1024, height: 1024 })
    store.insertCanvasImage({ topicId, userId, messageId: null, origin: 'generated', name: 'b', imageKey: 'kb', mimeType: 'image/webp', bytes: 1, width: 1024, height: 1024 })
    const first = (await (await GET(req(token), params(topicId))).json()) as { images: Array<{ canvasWidth: number }> }
    expect(first.images.every((p) => p.canvasWidth > 0)).toBe(true)
    const second = (await (await GET(req(token), params(topicId))).json()) as { images: unknown[] }
    expect(second.images).toEqual(first.images)
  })
})
