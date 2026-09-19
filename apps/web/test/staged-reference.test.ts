import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MotifStore } from '@motif/db'
import { removeStagedReference, resolveStagedReferences, saveReferenceImage, ServiceError } from '@/server/services'

let dir: string
let store: MotifStore
let userId: string
let topicId: string
let dataDir: string

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

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

  it('resolveStagedReferences：转正为画布图（origin=uploaded）并删除暂存行', () => {
    const user = store.getUserById(userId)!
    const ref = saveReferenceImage(store, dataDir, user, topicId, { buffer: PNG, mimeType: 'image/png' })
    const ids = resolveStagedReferences(store, user, topicId, [ref.id])
    expect(ids.length).toBe(1)
    const img = store.getCanvasImage(ids[0])!
    expect(img.origin).toBe('uploaded')
    expect(img.topicId).toBe(topicId)
    expect(store.listReferenceUploads(topicId)).toEqual([])
    expect(store.listCanvasImages(topicId).length).toBe(1)
  })

  it('别人的暂存参考不可转正', () => {
    const other = store.createUser({ name: 'x', email: 'x@e.com', passwordHash: 'x', role: 'user' })
    const otherTopic = store.createTopic(other.id, '别人的任务').id
    const ref = saveReferenceImage(store, dataDir, other, otherTopic, { buffer: PNG, mimeType: 'image/png' })
    const me = store.getUserById(userId)!
    expect(() => resolveStagedReferences(store, me, topicId, [ref.id])).toThrow(ServiceError)
  })

  it('removeStagedReference：本人可删、幂等；删除后画布仍为空', () => {
    const user = store.getUserById(userId)!
    const ref = saveReferenceImage(store, dataDir, user, topicId, { buffer: PNG, mimeType: 'image/png' })
    removeStagedReference(store, user, ref.id)
    removeStagedReference(store, user, ref.id) // 幂等
    expect(store.listReferenceUploads(topicId)).toEqual([])
    expect(store.listCanvasImages(topicId)).toEqual([])
  })
})
