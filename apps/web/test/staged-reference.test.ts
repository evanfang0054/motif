import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MotifStore } from '@motif/db'
import type { ImageProvider } from '@motif/image-provider'
import { enqueueGeneration, removeStagedReference, resolveStagedReferences, saveReferenceImage, ServiceError } from '@/server/services'

let dir: string
let store: MotifStore
let userId: string
let topicId: string
let dataDir: string

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

/** 桩 provider：不联网（本文件只测转正与退额，不会真的跑到生成） */
const stubProvider: ImageProvider = {
  name: 'stub',
  generate: async () => ({ buffer: PNG, mimeType: 'image/png', width: 1024, height: 1024 }),
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'motif-staged-'))
  dataDir = join(dir, 'data')
  store = new MotifStore(join(dir, 't.db'))
  userId = store.createUser({ name: 'u', email: 'u@e.com', passwordHash: 'x', role: 'user' }).id
  topicId = store.createTopic(userId, '任务A').id
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('暂存参考图（上传不进画布）', () => {
  it('上传后：暂存表有记录，画布为空', () => {
    const ref = saveReferenceImage(store, dataDir, store.getUserById(userId)!, topicId, { buffer: PNG, mimeType: 'image/png', name: '商品图.png' })
    expect(ref.id.startsWith('refu_')).toBe(true)
    expect(ref.name).toBe('商品图.png')
    expect(store.listReferenceUploads(topicId).length).toBe(1)
    expect(store.listCanvasImages(topicId)).toEqual([])
  })

  it('resolveStagedReferences：转正为画布图（origin=uploaded）并删除暂存行', async () => {
    const user = store.getUserById(userId)!
    const ref = saveReferenceImage(store, dataDir, user, topicId, { buffer: PNG, mimeType: 'image/png' })
    const ids = await resolveStagedReferences(store, dataDir, user, topicId, [ref.id])
    expect(ids.length).toBe(1)
    const img = store.getCanvasImage(ids[0])!
    expect(img.origin).toBe('uploaded')
    expect(img.topicId).toBe(topicId)
    expect(store.listReferenceUploads(topicId)).toEqual([])
    expect(store.listCanvasImages(topicId).length).toBe(1)
  })

  it('别人的暂存参考不可转正', async () => {
    const other = store.createUser({ name: 'x', email: 'x@e.com', passwordHash: 'x', role: 'user' })
    const otherTopic = store.createTopic(other.id, '别人的任务').id
    const ref = saveReferenceImage(store, dataDir, other, otherTopic, { buffer: PNG, mimeType: 'image/png' })
    const me = store.getUserById(userId)!
    await expect(resolveStagedReferences(store, dataDir, me, topicId, [ref.id])).rejects.toThrow(ServiceError)
  })

  it('removeStagedReference：本人可删、幂等；删除后画布仍为空', () => {
    const user = store.getUserById(userId)!
    const ref = saveReferenceImage(store, dataDir, user, topicId, { buffer: PNG, mimeType: 'image/png' })
    removeStagedReference(store, user, ref.id)
    removeStagedReference(store, user, ref.id) // 幂等
    expect(store.listReferenceUploads(topicId)).toEqual([])
    expect(store.listCanvasImages(topicId)).toEqual([])
  })

  it('转正失败必须退额：扣了钱又没建消息时不能吞掉额度', async () => {
    const user = store.getUserById(userId)!
    store.addCredits(userId, 10, { source: 'opening_balance', refId: null, note: '测试造数' })
    const before = store.getUserById(userId)!.credits
    await expect(
      enqueueGeneration(store, stubProvider, dataDir, user, {
        prompt: '一只白色陶瓷马克杯放在木桌上',
        count: 1,
        size: '1024x1024',
        enhance: false,
        topicId,
        // 已被删掉的暂存参考：转正时抛 400
        referenceCanvasImageIds: ['refu_not_there'],
      })
    ).rejects.toThrow(ServiceError)
    expect(store.getUserById(userId)!.credits).toBe(before)
  })
})
