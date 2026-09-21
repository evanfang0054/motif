import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { MotifStore } from '@motif/db'
import { allocateSlots, displaySize, placementRect, viewportOrigin } from '@motif/core'
import { rectsIntersect } from '@/lib/canvas/geometry'
import type { ImageProvider } from '@motif/image-provider'
import { executeMessage, resolveStagedReferences, saveReferenceImage } from '@/server/services'

let dir: string
let store: MotifStore
let userId: string
let topicId: string
let dataDir: string

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

/** 桩 provider：返回固定尺寸，不联网 */
function stubProvider(width: number, height: number): ImageProvider {
  return {
    name: 'stub',
    generate: async () => ({ buffer: PNG, mimeType: 'image/png', width, height }),
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'motif-place-write-'))
  dataDir = join(dir, 'data')
  store = new MotifStore(join(dir, 't.db'))
  userId = store.createUser({ name: 'u', email: 'u@e.com', passwordHash: 'x', role: 'user', credits: 100 }).id
  topicId = store.createTopic(userId, '任务A').id
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('生成产出自动带位置', () => {
  it('N=4：画布新增 4 行，各有非零位置、两两不重叠、各带 serial', async () => {
    const msg = store.createMessage({
      topicId, userId, prompt: 'p', finalPrompt: 'p', size: '1024x1024',
      requestedCount: 4, enhancePrompt: false, referenceIds: [],
    })
    await executeMessage({ store, provider: stubProvider(1024, 768), dataDir, workerId: 'w1' }, msg.id)

    const images = store.listCanvasImages(topicId)
    expect(images).toHaveLength(4)
    // 各带 #serial（serial 连续且唯一）
    expect(images.map((i) => i.serial).sort((a, b) => a - b)).toEqual([1, 2, 3, 4])
    // 各有非零位置与显示尺寸
    for (const img of images) {
      expect(img.canvasWidth).toBeGreaterThan(0)
      expect(img.canvasHeight).toBeGreaterThan(0)
      expect(img.updatedAt).not.toBe('')
    }
    // 两两矩形不重叠
    for (let i = 0; i < images.length; i += 1) {
      for (let j = i + 1; j < images.length; j += 1) {
        expect(rectsIntersect(placementRect(images[i]), placementRect(images[j]))).toBe(false)
      }
    }
    // 显示尺寸按原图比例（1024×768 → 240×180）
    expect(images[0].canvasWidth).toBeCloseTo(240, 6)
    expect(images[0].canvasHeight).toBeCloseTo(180, 6)
  })

  it('新产出落在当前视口内（视口平移后，新图出现在平移后的可见区）', async () => {
    store.setCanvasMeta(topicId, { viewport: { x: -2800, y: -2800, k: 1 }, background: 'lines', version: 1 })
    const msg = store.createMessage({
      topicId, userId, prompt: 'p', finalPrompt: 'p', size: '1024x1024',
      requestedCount: 1, enhancePrompt: false, referenceIds: [],
    })
    await executeMessage({ store, provider: stubProvider(1024, 1024), dataDir, workerId: 'w1' }, msg.id)
    // 视口原点 = (2800, 2800)；槽位 0 就在原点
    expect(store.listCanvasPlacements(topicId)[0].canvasX).toBeCloseTo(2800, 6)
    expect(store.listCanvasPlacements(topicId)[0].canvasY).toBeCloseTo(2800, 6)
  })

  it('断点续跑：已有 2 张时补跑，4 张仍两两不重叠（不压住已有图）', async () => {
    const msg = store.createMessage({
      topicId, userId, prompt: 'p', finalPrompt: 'p', size: '1024x1024',
      requestedCount: 4, enhancePrompt: false, referenceIds: [],
    })
    // 造「崩溃前已跑出 2 张」：手工插 2 行带位置、message_id 指向本条消息
    const origin = viewportOrigin(store.getCanvasMeta(topicId).viewport)
    const slots = allocateSlots([], [displaySize(1024, 1024), displaySize(1024, 1024)], origin)
    slots.forEach((s, i) => {
      store.insertCanvasImage({
        topicId, userId, messageId: msg.id, origin: 'generated', name: `图片 ${i + 1}`,
        imageKey: `pre${i}`, mimeType: 'image/png', bytes: 1, width: 1024, height: 1024,
        placement: { x: s.x, y: s.y, width: s.w, height: s.h },
      })
    })
    expect(store.countGeneratedInMessage(msg.id)).toBe(2) // 断点续跑的起点

    await executeMessage({ store, provider: stubProvider(1024, 1024), dataDir, workerId: 'w1' }, msg.id)

    const images = store.listCanvasImages(topicId)
    expect(images).toHaveLength(4) // 只补了剩余 2 张，没有超发
    // ⚠️ 必须先断言「四张都有非零尺寸」：零面积矩形在相交判定里恒为「不相交」，
    // 只查不重叠的话，位置没写进去时这个测试照样会绿（假通过）。
    for (const img of images) {
      expect(img.canvasWidth).toBeGreaterThan(0)
      expect(img.canvasHeight).toBeGreaterThan(0)
      expect(img.updatedAt).not.toBe('')
    }
    for (let i = 0; i < images.length; i += 1) {
      for (let j = i + 1; j < images.length; j += 1) {
        expect(rectsIntersect(placementRect(images[i]), placementRect(images[j]))).toBe(false)
      }
    }
  })
})

describe('暂存参考转正也带位置', () => {
  it('上传后画布为空；转正后该图有非零位置、origin=uploaded，且读的是原图真实尺寸', async () => {
    const user = store.getUserById(userId)!
    const ref = saveReferenceImage(store, dataDir, user, topicId, { buffer: PNG, mimeType: 'image/png', name: '参考图.png' })
    expect(store.listCanvasImages(topicId)).toHaveLength(0) // 上传不进画布
    // 上传的是坏字节（只有 PNG 头）：读尺寸失败 → 回退 0，仍要能转正
    const ids = await resolveStagedReferences(store, dataDir, user, topicId, [ref.id])
    const img = store.getCanvasImage(ids[0])!
    expect(img.origin).toBe('uploaded')
    expect(img.width).toBe(0)
    expect(img.height).toBe(0)
    expect(img.canvasWidth).toBe(240)
    expect(img.canvasHeight).toBe(240)
    expect(img.updatedAt).not.toBe('')
  })

  it('转正时按原图真实像素尺寸落库并据此分配显示尺寸（横版 400×300）', async () => {
    const user = store.getUserById(userId)!
    const file = join(dir, 'landscape.png')
    await sharp({ create: { width: 400, height: 300, channels: 3, background: '#fff' } }).png().toFile(file)
    const ref = saveReferenceImage(store, dataDir, user, topicId, { buffer: readFileSync(file), mimeType: 'image/png', name: '横版.png' })
    const ids = await resolveStagedReferences(store, dataDir, user, topicId, [ref.id])
    const img = store.getCanvasImage(ids[0])!
    expect(img.width).toBe(400)
    expect(img.height).toBe(300)
    // 长边压到 240 → 240×180
    expect(img.canvasWidth).toBeCloseTo(240, 6)
    expect(img.canvasHeight).toBeCloseTo(180, 6)
  })

  it('竖版参考图（300×400）落库后高 > 宽 —— 这正是「渲染按原图比例、模型按 240 方形」分歧的成因', async () => {
    const user = store.getUserById(userId)!
    const file = join(dir, 'portrait.png')
    await sharp({ create: { width: 300, height: 400, channels: 3, background: '#fff' } }).png().toFile(file)
    const ref = saveReferenceImage(store, dataDir, user, topicId, { buffer: readFileSync(file), mimeType: 'image/png', name: '竖版.png' })
    const ids = await resolveStagedReferences(store, dataDir, user, topicId, [ref.id])
    const img = store.getCanvasImage(ids[0])!
    expect(img.width).toBe(300)
    expect(img.height).toBe(400)
    expect(img.canvasHeight).toBeCloseTo(240, 6)
    expect(img.canvasWidth).toBeCloseTo(180, 6)
    expect(img.canvasHeight).toBeGreaterThan(img.canvasWidth)
  })
})
