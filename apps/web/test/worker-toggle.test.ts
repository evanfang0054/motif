import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MotifStore } from '@motif/db'
import { runWorkerTick, startWorker, stopWorker, type WorkerState } from '@/server/worker'
import { enqueueGeneration } from '@/server/services'
import type { GeneratedImage, ImageProvider } from '@motif/image-provider'

/**
 * MOTIF_INPROC_WORKER 开关：关掉只是「本进程不跑」，队列的驱动能力必须保留
 * （独立进程 `pnpm worker` 与测试都靠 runWorkerTick 直接驱动）。
 */
let dir: string
let store: MotifStore

const stubProvider: ImageProvider = {
  name: 'stub',
  generate: async (): Promise<GeneratedImage> => ({
    buffer: Buffer.from('stub'),
    mimeType: 'image/png',
    width: 1,
    height: 1,
  }),
}

/** 注入桩 runtime：runWorkerTick 每轮从 runtime 现取 provider（刻意不缓存），故只能这样喂桩 */
function installRuntime(provider: ImageProvider): void {
  const g = globalThis as unknown as { __motifRuntime?: unknown }
  g.__motifRuntime = {
    store,
    provider,
    mailer: { mailer: { name: 'stub', sendVerificationCode: async () => {} }, isConsole: true },
    dataDir: dir,
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'motif-wtoggle-'))
  // ⚠️ 必须与 getRuntime() 用**同一个库文件**（它读 MOTIF_DATA_DIR/motif.db）：
  // 建成 t.db 会让「测试写入的设置」与「worker 读到的设置」分属两个文件，开关永远读不到。
  store = new MotifStore(join(dir, 'motif.db'))
  process.env.MOTIF_DATA_DIR = dir
  // 显式注入桩值：不依赖宿主环境里有没有 .env
  process.env.IMAGE_API_BASE_URL = 'http://127.0.0.1:9'
  process.env.IMAGE_API_KEY = 'stub'
  delete (globalThis as unknown as { __motifRuntime?: unknown }).__motifRuntime
  delete (globalThis as unknown as { __motifWorker?: unknown }).__motifWorker
})

afterEach(() => {
  stopWorker()
  store.close()
  rmSync(dir, { recursive: true, force: true })
  delete (globalThis as unknown as { __motifRuntime?: unknown }).__motifRuntime
  delete process.env.MOTIF_DATA_DIR
  delete process.env.IMAGE_API_BASE_URL
  delete process.env.IMAGE_API_KEY
})

describe('MOTIF_INPROC_WORKER 开关', () => {
  it('默认（键缺失）启动 worker 并挂定时器 —— 与改造前一致', () => {
    const g = globalThis as unknown as { __motifWorker?: { timer: unknown } }
    expect(startWorker()).toBe(true)
    expect(g.__motifWorker).toBeTruthy()
    expect(g.__motifWorker!.timer).toBeTruthy()
  })

  it('显式关闭时不启动 worker（不建定时器、不占 globalThis），且返回 false', () => {
    const g = globalThis as unknown as { __motifWorker?: unknown }
    store.setSetting('MOTIF_INPROC_WORKER', 'false')
    // 返回值必须区分「启动了」与「没启动」：独立进程入口靠它决定保活还是直接退出，
    // 否则开关关着会留下一个什么都不干的僵尸进程。
    expect(startWorker()).toBe(false)
    expect(g.__motifWorker).toBeUndefined()
  })

  it('关闭开关只拿掉定时器，runWorkerTick 仍能消费队列（能力保留）', async () => {
    store.setSetting('MOTIF_INPROC_WORKER', 'false')
    startWorker()
    // runWorkerTick 用的是 runtime 里的 provider（不缓存，每轮现取），故注入桩 runtime
    installRuntime(stubProvider)
    const user = store.createUser({ email: 'wt@b.co', passwordHash: 'h', name: 'w', credits: 4 })
    const res = await enqueueGeneration(store, stubProvider, dir, user, {
      prompt: '晨光中的白瓷马克杯',
      count: 1,
      size: '1024x1024',
      enhance: false,
      topicId: null,
      referenceCanvasImageIds: [],
    })
    const state: WorkerState = {
      store,
      dataDir: dir,
      workerId: 'worker-test',
      busy: false,
      timer: null,
      inFlight: new Set<string>(),
    }
    await runWorkerTick(state)
    expect(store.getMessage(res.messageId)!.status).toBe('completed')
  })

  it('⚠️ 回归：独立进程（standalone）必须无视开关 —— 否则「关掉进程内 worker 改用 pnpm worker 接管」直接失效', () => {
    const g = globalThis as unknown as { __motifWorker?: { timer: unknown } }
    store.setSetting('MOTIF_INPROC_WORKER', 'false')
    // 开关语义是「web 进程不跑」，不是「谁都不许跑」。独立进程存在的唯一理由就是接管队列，
    // 若它也读这个开关，运维照日志提示跑 `pnpm worker` 会立刻退出、队列彻底没人消费。
    expect(startWorker({ standalone: true })).toBe(true)
    expect(g.__motifWorker).toBeTruthy()
    expect(g.__motifWorker!.timer).toBeTruthy()
  })

  it('standalone 与 web 进程语义不同：同一开关下前者起、后者不起', () => {
    store.setSetting('MOTIF_INPROC_WORKER', 'false')
    expect(startWorker()).toBe(false)
    expect(startWorker({ standalone: true })).toBe(true)
  })
})
