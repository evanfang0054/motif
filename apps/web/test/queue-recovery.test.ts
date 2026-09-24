import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

describe('槽位计划落位（#88：出图与骨架同坐标，出图就地填入不跳动）', () => {
  it('入队即生成 N 个计划槽，auto 一律按 1:1 占位（D13）', async () => {
    const { messageId } = await enqueue(3)
    const plan = store.getMessage(messageId)!.slotPlan
    expect(plan).toHaveLength(3)
    expect(plan[0]).toEqual({ x: 0, y: 0, w: 240, h: 240 })
    expect(plan[1]).toEqual({ x: 280, y: 0, w: 240, h: 240 })
    expect(plan.every((s) => s.w === 240 && s.h === 240)).toBe(true)
  })

  it('worker 出图落回计划槽坐标（左上角与骨架完全一致）', async () => {
    const { messageId, topicId } = await enqueue(3)
    const plan = store.getMessage(messageId)!.slotPlan
    const calls: number[] = []
    await executeMessage(makeDeps(countingProvider(calls)), messageId)
    const placements = store.listCanvasPlacements(topicId)
    expect(placements).toHaveLength(3)
    for (let i = 0; i < 3; i += 1) {
      expect({ x: placements[i].canvasX, y: placements[i].canvasY }).toEqual({ x: plan[i].x, y: plan[i].y })
    }
  })

  it('出图比例与占位不同：只变尺寸、左上角不动，且不压相邻槽', async () => {
    // 请求 auto（1:1 占位），实际出横图 2:1 —— 平滑过渡到 240×120，坐标钉在计划槽
    const user = store.createUser({ email: 'wide@b.co', passwordHash: 'h', name: 'w', credits: 4 })
    const res = await enqueueGeneration(store, countingProvider([]), dir, user, {
      prompt: '横图', count: 2, size: 'auto', enhance: false, topicId: null, referenceCanvasImageIds: [],
    })
    const plan = store.getMessage(res.messageId)!.slotPlan
    const wide: ImageProvider = {
      name: 'wide-stub',
      generate: async () => ({ buffer: Buffer.from('x'), mimeType: 'image/png', width: 1024, height: 512 }),
    }
    await executeMessage(makeDeps(wide), res.messageId)
    const placements = store.listCanvasPlacements(res.topic.id)
    expect({ x: placements[0].canvasX, y: placements[0].canvasY }).toEqual({ x: plan[0].x, y: plan[0].y })
    expect([placements[0].canvasWidth, placements[0].canvasHeight]).toEqual([240, 120])
    // 槽步长 280：右缘 240 < 下一槽 x=280，横图不会压到相邻图
    expect(placements[0].canvasX + placements[0].canvasWidth).toBeLessThanOrEqual(plan[1].x)
  })

  it('取消：退额数 = requestedCount − 已落库张数（与骨架摘除数同源）', async () => {
    // 12 张里已落 4 张 → 退 8；取消前活跃轮次的骨架也恰好剩 8 个（见 canvas-skeleton 单测）
    const { user, messageId, topicId } = await enqueue(12, 20)
    seedGenerated(messageId, user.id, topicId, 4)
    store.setMessageStatus(messageId, 'canceling')
    await executeMessage(makeDeps(countingProvider([])), messageId)
    expect(store.getMessage(messageId)!.status).toBe('canceled')
    expect(store.getUserById(user.id)!.credits).toBe(16) // 20 − 12 + 退 8
  })

  it('每落库一张就 touch 一次 topic —— watch 长轮询据此即时刷新，实现「出图就地填入」', async () => {
    // 不 touch 的话整批只会在收尾被看到一次，骨架与「N 张图片」直到最后才更新
    const { messageId, topicId } = await enqueue(3)
    const spy = vi.spyOn(store, 'touchTopic')
    await executeMessage(makeDeps(countingProvider([])), messageId)
    expect(spy).toHaveBeenCalledTimes(3)
    expect(spy.mock.calls.every(([id]) => id === topicId)).toBe(true)
    spy.mockRestore()
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
