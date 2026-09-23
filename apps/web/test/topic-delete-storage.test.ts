import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { NextRequest } from 'next/server'
import { MotifStore, storagePathFor } from '@motif/db'
import { SESSION_COOKIE } from '@/server/auth'
import { DELETE } from '@/app/api/topics/[id]/route'

/**
 * #61：删任务要连存储对象一起清。
 *
 * 旧实现 `getRuntime().store.deleteTopic(id)` 把返回值丢掉了 —— 连画布图都不清，
 * 更别说暂存参考图（那时根本不在返回值里）。这里两条都钉住。
 */

let dir: string
let dataDir: string
let store: MotifStore
let token: string
let userId: string
let topicId: string

function req(token: string | undefined): NextRequest {
  return {
    cookies: { get: (name: string) => (name === SESSION_COOKIE && token ? { value: token } : undefined) },
  } as unknown as NextRequest
}
const params = (id: string) => ({ params: Promise.resolve({ id }) })

/** 造出「文件真的在盘上」的对象，返回 key */
function seedObject(key: string): string {
  const abs = storagePathFor(dataDir, key)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, 'bytes')
  return key
}
const onDisk = (key: string) => existsSync(storagePathFor(dataDir, key))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'motif-topic-del-'))
  dataDir = join(dir, 'data')
  store = new MotifStore(join(dir, 't.db'))
  ;(globalThis as unknown as { __motifRuntime?: unknown }).__motifRuntime = { store, dataDir }
  userId = store.createUser({ name: 'u', email: 'u@e.com', passwordHash: 'h', role: 'user' }).id
  token = store.createSession(userId, 60_000)
  topicId = store.createTopic(userId, '任务A').id
})
afterEach(() => {
  delete (globalThis as unknown as { __motifRuntime?: unknown }).__motifRuntime
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('DELETE /api/topics/[id] 要清存储', () => {
  it('画布图与暂存参考图的对象**都**被删掉（暂存参考是旧实现漏掉的那类）', async () => {
    const canvasKey = seedObject('users/u/topics/t/messages/m/generated/a.png')
    const stagedKey = seedObject('users/u/topics/t/references/b.png')
    store.insertCanvasImage({
      topicId,
      userId,
      messageId: null,
      origin: 'generated',
      name: 'g',
      imageKey: canvasKey,
      mimeType: 'image/png',
      bytes: 1,
      width: 8,
      height: 8,
    })
    store.insertReferenceUpload({
      topicId,
      userId,
      name: 'r',
      imageKey: stagedKey,
      mimeType: 'image/png',
      bytes: 1,
    })
    expect(onDisk(canvasKey)).toBe(true)
    expect(onDisk(stagedKey)).toBe(true)

    const res = await DELETE(req(token), params(topicId))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(store.getTopic(topicId)).toBeNull()
    expect(onDisk(canvasKey)).toBe(false)
    expect(onDisk(stagedKey)).toBe(false)
  })

  it('⚠️ 反证：只删行不清对象时，两个文件都会留下（这就是 #61 的现状）', () => {
    const canvasKey = seedObject('users/u/topics/t/canvas.png')
    const stagedKey = seedObject('users/u/topics/t/staged.png')
    store.insertCanvasImage({
      topicId,
      userId,
      messageId: null,
      origin: 'generated',
      name: 'g',
      imageKey: canvasKey,
      mimeType: 'image/png',
      bytes: 1,
      width: 8,
      height: 8,
    })
    store.insertReferenceUpload({
      topicId,
      userId,
      name: 'r',
      imageKey: stagedKey,
      mimeType: 'image/png',
      bytes: 1,
    })
    // 旧实现等价于只调 deleteTopic 且丢弃返回值
    store.deleteTopic(topicId)
    expect(onDisk(canvasKey)).toBe(true)
    expect(onDisk(stagedKey)).toBe(true)
  })

  it('没有图片的任务也能删（零 key 时不报错）', async () => {
    const res = await DELETE(req(token), params(topicId))
    expect(res.status).toBe(200)
    expect(store.getTopic(topicId)).toBeNull()
  })

  it('未登录 401，且任务与对象都还在', async () => {
    const key = seedObject('users/u/topics/t/a.png')
    store.insertReferenceUpload({ topicId, userId, name: 'r', imageKey: key, mimeType: 'image/png', bytes: 1 })
    expect((await DELETE(req(undefined), params(topicId))).status).toBe(401)
    expect(store.getTopic(topicId)).not.toBeNull()
    expect(onDisk(key)).toBe(true)
  })

  it('他人的任务 404，且对象一个不动（校验不过就不该清文件）', async () => {
    const other = store.createUser({ name: 'x', email: 'x@e.com', passwordHash: 'h', role: 'user' })
    const otherTopic = store.createTopic(other.id, '别人的').id
    const key = seedObject('users/x/topics/o/a.png')
    store.insertReferenceUpload({ topicId: otherTopic, userId: other.id, name: 'r', imageKey: key, mimeType: 'image/png', bytes: 1 })

    expect((await DELETE(req(token), params(otherTopic))).status).toBe(404)
    expect(store.getTopic(otherTopic)).not.toBeNull()
    expect(onDisk(key)).toBe(true)
  })

  it('不存在的任务 404', async () => {
    expect((await DELETE(req(token), params('topic_nope'))).status).toBe(404)
  })
})
