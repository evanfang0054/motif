import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { enqueueGeneration, executeMessage, type WorkerDeps } from '@/server/services'
import { startWorker, stopWorker } from '@/server/worker'
import { MotifStore } from '@motif/db'
import type { GeneratedImage, ImageProvider } from '@motif/image-provider'

let dir: string
let store: MotifStore

// 计数桩：登记每次调用的 indexInBatch，返回 1x1 占位图
function countingProvider(calls: number[]): ImageProvider {
  return {
    name: 'counting-stub',
    generate: async (req) => {
      calls.push(req.indexInBatch)
      const img: GeneratedImage = { buffer: Buffer.from('stub'), mimeType: 'image/png', width: 1, height: 1 }
      return img
    },
  }
}

function makeDeps(provider: ImageProvider): WorkerDeps {
  return { store, provider, dataDir: dir, workerId: 'worker-test' }
}

// 入队 count 张（预扣额度），返回 messageId/topicId 与用户
async function enqueue(count: number, credits = 8) {
  const user = store.createUser({ email: `r${count}@b.co`, passwordHash: 'h', name: 'r', credits })
  const res = await enqueueGeneration(store, countingProvider([]), dir, user, {
    prompt: '晨光中的白瓷马克杯',
    count,
    size: '1024x1024',
    enhance: false,
    topicId: null,
    referenceCanvasImageIds: [],
  })
  return { user, messageId: res.messageId, topicId: res.topic.id }
}

// 手工预置「崩溃前已生成 n 张」
function seedGenerated(messageId: string, userId: string, topicId: string, n: number) {
  for (let k = 0; k < n; k++) {
    store.insertCanvasImage({
      topicId, userId, messageId, origin: 'generated',
      name: `图片 ${k + 1}`, imageKey: `pre-${k}`, mimeType: 'image/png', bytes: 4, width: 1, height: 1,
    })
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'motif-resume-'))
  store = new MotifStore(join(dir, 't.db'))
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('断点续跑（崩溃恢复）', () => {
  it('已生成 1/2 张：重跑只补 1 张、状态 completed、全程无退额', async () => {
    const { user, messageId, topicId } = await enqueue(2) // 8 - 2 = 6
    seedGenerated(messageId, user.id, topicId, 1)
    const calls: number[] = []
    await executeMessage(makeDeps(countingProvider(calls)), messageId)
    expect(calls).toEqual([1]) // indexInBatch 从已生成数 1 起续跑
    expect(store.countGeneratedInMessage(messageId)).toBe(2)
    expect(store.getMessage(messageId)!.status).toBe('completed')
    expect(store.getUserById(user.id)!.credits).toBe(6)
  })

  it('已生成 2/2 张（生成完但未及落状态即崩溃）：重跑 0 次生图直接 completed', async () => {
    const { user, messageId, topicId } = await enqueue(2)
    seedGenerated(messageId, user.id, topicId, 2)
    const calls: number[] = []
    await executeMessage(makeDeps(countingProvider(calls)), messageId)
    expect(calls).toEqual([])
    expect(store.getMessage(messageId)!.status).toBe('completed')
    expect(store.getUserById(user.id)!.credits).toBe(6)
  })

  it('续跑时已是 canceling：不再生图，按已生成数退额（2-1=1 张）', async () => {
    const { user, messageId, topicId } = await enqueue(2) // 6
    seedGenerated(messageId, user.id, topicId, 1)
    store.setMessageStatus(messageId, 'canceling')
    const calls: number[] = []
    await executeMessage(makeDeps(countingProvider(calls)), messageId)
    expect(calls).toEqual([])
    expect(store.getMessage(messageId)!.status).toBe('canceled')
    expect(store.getUserById(user.id)!.credits).toBe(7) // 6 + 退 1
  })

  it('全新消息（0 已生成）：行为不变，全量生成', async () => {
    const { user, messageId } = await enqueue(2)
    const calls: number[] = []
    await executeMessage(makeDeps(countingProvider(calls)), messageId)
    expect(calls).toEqual([0, 1])
    expect(store.countGeneratedInMessage(messageId)).toBe(2)
    expect(store.getMessage(messageId)!.status).toBe('completed')
    expect(store.getUserById(user.id)!.credits).toBe(6)
  })

  it('续跑中失败：provider 抛错 → 按已生成数退额（2-1=1）且不落新图', async () => {
    const { user, messageId, topicId } = await enqueue(2) // 6
    seedGenerated(messageId, user.id, topicId, 1)
    const calls: number[] = []
    const failing: ImageProvider = {
      name: 'failing-stub',
      generate: async (req) => {
        calls.push(req.indexInBatch)
        throw new Error('网关超时')
      },
    }
    await executeMessage(makeDeps(failing), messageId)
    expect(calls.length).toBe(1) // 恰尝试补 1 张
    expect(store.getMessage(messageId)!.status).toBe('failed')
    expect(store.countGeneratedInMessage(messageId)).toBe(1) // 失败不写图
    expect(store.getUserById(user.id)!.credits).toBe(7) // 6 + 退 1
  })
})

describe('worker 启动', () => {
  it('startWorker 幂等：重复调用不重复启动，stopWorker 可清理', () => {
    const g = globalThis as unknown as {
      __motifRuntime?: unknown
      __motifWorker?: { timer: ReturnType<typeof setInterval> | null }
    }
    process.env.MOTIF_DATA_DIR = dir // 隔离：getRuntime 建库落在临时目录
    // 显式注入桩值：让本测试不依赖宿主环境里有没有 .env（配置缺失时已不再抛错）
    process.env.IMAGE_API_BASE_URL = 'http://127.0.0.1:9'
    process.env.IMAGE_API_KEY = 'stub'
    delete g.__motifRuntime
    delete g.__motifWorker
    try {
      startWorker()
      // 显式标注：delete / 赋 undefined 都会把可选属性收窄成 undefined，不标注则 first!.timer 塌成 never
      const first: { timer: ReturnType<typeof setInterval> | null } | undefined = g.__motifWorker
      expect(first).toBeTruthy()
      startWorker()
      expect(g.__motifWorker).toBe(first) // globalThis 守卫：同一实例
      expect(first!.timer).toBeTruthy() // 定时器已挂载
    } finally {
      stopWorker()
      expect(g.__motifWorker).toBeUndefined()
      delete g.__motifRuntime
      delete process.env.MOTIF_DATA_DIR
      delete process.env.IMAGE_API_BASE_URL
      delete process.env.IMAGE_API_KEY
    }
  })
})
