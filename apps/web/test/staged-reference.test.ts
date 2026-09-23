import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MotifStore, storagePathFor } from '@motif/db'
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
  // 存储层（resolveLocalStorage / resolveRemoteStorage）要经 getRuntime() 拿配置；
  // 不注入的话它会懒建一个指向 cwd/.data 的 runtime —— 那会写到仓库目录里（#61 起删除路径也要走它）
  ;(globalThis as unknown as { __motifRuntime?: unknown }).__motifRuntime = { store, dataDir }
  userId = store.createUser({ name: 'u', email: 'u@e.com', passwordHash: 'x', role: 'user' }).id
  topicId = store.createTopic(userId, '任务A').id
})
afterEach(() => {
  delete (globalThis as unknown as { __motifRuntime?: unknown }).__motifRuntime
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('暂存参考图（上传不进画布）', () => {
  it('上传后：暂存表有记录，画布为空', async () => {
    const ref = await saveReferenceImage(store, dataDir, store.getUserById(userId)!, topicId, { buffer: PNG, mimeType: 'image/png', name: '商品图.png' })
    expect(ref.id.startsWith('refu_')).toBe(true)
    expect(ref.name).toBe('商品图.png')
    expect(store.listReferenceUploads(topicId).length).toBe(1)
    expect(store.listCanvasImages(topicId)).toEqual([])
  })

  it('resolveStagedReferences：转正为画布图（origin=uploaded）并删除暂存行', async () => {
    const user = store.getUserById(userId)!
    const ref = await saveReferenceImage(store, dataDir, user, topicId, { buffer: PNG, mimeType: 'image/png' })
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
    const ref = await saveReferenceImage(store, dataDir, other, otherTopic, { buffer: PNG, mimeType: 'image/png' })
    const me = store.getUserById(userId)!
    await expect(resolveStagedReferences(store, dataDir, me, topicId, [ref.id])).rejects.toThrow(ServiceError)
  })

  it('removeStagedReference：本人可删、幂等；删除后画布仍为空', async () => {
    const user = store.getUserById(userId)!
    const ref = await saveReferenceImage(store, dataDir, user, topicId, { buffer: PNG, mimeType: 'image/png' })
    await removeStagedReference(store, dataDir, user, ref.id)
    await removeStagedReference(store, dataDir, user, ref.id) // 幂等
    expect(store.listReferenceUploads(topicId)).toEqual([])
    expect(store.listCanvasImages(topicId)).toEqual([])
  })

  it('⚠️ #61：删暂存参考要连**对象**一起清（旧实现只删行 → 文件永远留在盘上）', async () => {
    const user = store.getUserById(userId)!
    const ref = await saveReferenceImage(store, dataDir, user, topicId, { buffer: PNG, mimeType: 'image/png' })
    const abs = storagePathFor(dataDir, ref.imageKey)
    expect(existsSync(abs)).toBe(true)

    await removeStagedReference(store, dataDir, user, ref.id)
    expect(existsSync(abs)).toBe(false)
  })

  it('别人的暂存参考删不掉，且**对象仍在**（校验不过就不该动文件）', async () => {
    const other = store.createUser({ name: 'x', email: 'x@e.com', passwordHash: 'x', role: 'user' })
    const otherTopic = store.createTopic(other.id, '别人的任务').id
    const ref = await saveReferenceImage(store, dataDir, other, otherTopic, { buffer: PNG, mimeType: 'image/png' })
    const me = store.getUserById(userId)!
    await expect(removeStagedReference(store, dataDir, me, ref.id)).rejects.toThrow(ServiceError)
    expect(existsSync(storagePathFor(dataDir, ref.imageKey))).toBe(true)
    expect(store.listReferenceUploads(otherTopic).length).toBe(1)
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

    // 光看余额不够：余额相等也可能是「压根没扣」或「扣了又补了」——
    // 必须断言流水里确实有一扣一退，且两者相抵（额度守恒的账面证据）
    const rows = store.listLedger({ userId, limit: 10 })
    const charge = rows.find((r) => r.source === 'generation_charge')
    const refund = rows.find((r) => r.source === 'generation_refund')
    expect(charge?.delta).toBe(-1) // 按张扣费：count=1
    expect(refund?.delta).toBe(1)
    expect(rows.filter((r) => r.source.startsWith('generation_')).reduce((n, r) => n + r.delta, 0)).toBe(0)
  })

  it('转正失败不留半截：多张参考里有一张非法时，画布与暂存表都保持原样', async () => {
    const user = store.getUserById(userId)!
    const ok = await saveReferenceImage(store, dataDir, user, topicId, { buffer: PNG, mimeType: 'image/png', name: 'ok.png' })
    // 第二张非法 → 两遍走的第一遍就抛，不该留下 ok.png 已转正的痕迹
    await expect(resolveStagedReferences(store, dataDir, user, topicId, [ok.id, 'refu_gone'])).rejects.toThrow(ServiceError)
    expect(store.listCanvasImages(topicId)).toEqual([])
    expect(store.listReferenceUploads(topicId).map((r) => r.id)).toEqual([ok.id])
  })
})
