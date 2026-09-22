import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { MotifStore, storagePathFor } from '@motif/db'
import type { GeneratedImage, ImageProvider } from '@motif/image-provider'
import { resolveLocalStorage, resolveReadStorages, resolveRemoteStorage, resolveStorage } from '@/server/context'
import { writeSettings } from '@/server/settings'
import { readImageWithFallback } from '@/server/storage'
import { enqueueGeneration } from '@/server/services'
import { runWorkerTick, type WorkerState } from '@/server/worker'

/**
 * 双读的**接线**测试（不是判定测试）。
 *
 * 为什么单独要这一组：`storage-driver.test.ts` 里的双读用例把 local / remote 两个 Storage 当参数
 * **注入**进去，于是它只证明了 `readImageWithFallback` 本身的分支逻辑 —— 而真实调用链是
 * 「用 context 里的 resolver 现取两侧」。s3 驱动下 `resolveStorage()` 返回的是**远端**，
 * 若调用方拿它当「本地」，双读的两个入参就变成同一个远端：本地老图直接 404。
 * 这个 bug 单测全绿、dev 实测才暴露，所以必须有一组测试**走真 resolver**把接线钉住。
 */
let dir: string
let store: MotifStore
const KEY = 'users/u1/topics/t1/messages/m1/generated/old.png'

/** 造一张「改造前就在本地盘上的老图」 */
function seedLocalImage() {
  const abs = storagePathFor(dir, KEY)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, 'legacy-bytes')
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'motif-dualread-'))
  // ⚠️ 必须与 getRuntime() 同一个库文件（它读 MOTIF_DATA_DIR/motif.db），否则设置写不到读取处
  store = new MotifStore(join(dir, 'motif.db'))
  process.env.MOTIF_DATA_DIR = dir
  delete (globalThis as unknown as { __motifRuntime?: unknown }).__motifRuntime
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
  delete (globalThis as unknown as { __motifRuntime?: unknown }).__motifRuntime
  delete process.env.MOTIF_DATA_DIR
})

/** 指向一个**必然不可达**的端点：用它来证明「本地命中时根本不该碰远端」 */
const UNREACHABLE = {
  S3_ENDPOINT: 'http://127.0.0.1:9',
  S3_BUCKET: 'motif-test',
  S3_ACCESS_KEY_ID: 'k',
  S3_SECRET_ACCESS_KEY: 's',
  S3_FORCE_PATH_STYLE: 'true',
}

describe('s3 驱动下「本地」仍指本地目录', () => {
  it('⚠️ 回归：resolveStorage 在 s3 驱动下返回远端，不能拿它当双读的「本地」', () => {
    writeSettings(store, { STORAGE_DRIVER: 's3', ...UNREACHABLE }, { danger: false })
    // 这条断言是这组测试的立意：两个 resolver 在 s3 驱动下**不是**一回事
    expect(resolveRemoteStorage()).not.toBeNull()
    // 本地 resolver 与驱动无关：永远是本地实现（读的是 dataDir 下的文件）
    seedLocalImage()
    return expect(resolveLocalStorage().exists(KEY)).resolves.toBe(true)
  })

  it('⚠️ 回归：s3 驱动 + 本地有老图 → 双读读到本地（且远端不可达也不影响）', async () => {
    writeSettings(store, { STORAGE_DRIVER: 's3', ...UNREACHABLE }, { danger: false })
    seedLocalImage()
    const { local, remote } = resolveReadStorages()
    // 远端故意不可达：若实现「本地优先」正确，这里根本不会去连它
    expect(remote).not.toBeNull()
    await expect(readImageWithFallback(local, remote, KEY)).resolves.toEqual(Buffer.from('legacy-bytes'))
  })

  it('resolveReadStorages 的 local 与 remote 是两个不同实现（s3 驱动下）', () => {
    writeSettings(store, { STORAGE_DRIVER: 's3', ...UNREACHABLE }, { danger: false })
    const { local, remote } = resolveReadStorages()
    // 拿同一个 key 探两侧：本地缺失、远端不可达 → 两边行为必须不同（否则就是同一个东西）
    return Promise.all([
      local.exists('nope.png'),
      remote!.exists(KEY).then(
        () => 'reachable',
        () => 'unreachable'
      ),
    ]).then(([localHas, remoteState]) => {
      expect(localHas).toBe(false)
      expect(remoteState).toBe('unreachable')
    })
  })

  it('local 驱动下 remote 为 null（不做无意义的远端探测）', () => {
    const { local, remote } = resolveReadStorages()
    expect(remote).toBeNull()
    seedLocalImage()
    return expect(local.exists(KEY)).resolves.toBe(true)
  })

  it('写路径仍按驱动走：s3 驱动下 resolveStorage 不是本地实现', () => {
    writeSettings(store, { STORAGE_DRIVER: 's3', ...UNREACHABLE }, { danger: false })
    // 写路径必须落在远端（切了驱动后新图不该再写本地盘）—— 用「不可达端点会抛错」反证
    return expect(resolveStorage().write(KEY, Buffer.from('x'))).rejects.toThrow()
  })

  it('反证：旧的接线（拿 resolveStorage() 当「本地」）读不到本地老图 —— 这就是修掉的那个 bug', async () => {
    writeSettings(store, { STORAGE_DRIVER: 's3', ...UNREACHABLE }, { danger: false })
    seedLocalImage()
    // 旧写法：readImageWithFallback(resolveStorage(), resolveRemoteStorage(), …)
    // s3 驱动下两个参数是同一个远端 → 「本地优先」失效 → 本地老图读不出来
    //（远端不可达时抛连接错误；远端可达但没有该 key 时抛「不存在」—— 两种都不是本地字节）
    // 这条断言保证：若将来有人把接线改回去，测试立刻变红（而不是像原来那样全绿）。
    await expect(readImageWithFallback(resolveStorage(), resolveRemoteStorage(), KEY)).rejects.toThrow()
    // 而正确接线读得到
    const { local, remote } = resolveReadStorages()
    await expect(readImageWithFallback(local, remote, KEY)).resolves.toEqual(Buffer.from('legacy-bytes'))
  })
})

/**
 * 生成图的**写入落点**必须按驱动走。
 *
 * 这一组是被实测暴露的回归钉住的：把 `resolveReadStorages()` 解构出的 `local` 直接当写入目标，
 * 会让 s3 驱动下新图永远只落本地盘、根本进不了 S3（而因为读路径「本地优先」，dev 与单测都看不出来）。
 * 反向证明手法与上面一致：把远端指向**必然不可达**的端点 ——
 *   s3 驱动 → 写远端会抛错，且本地目录必须**保持为空**（若代码写本地，这里会变红）
 *   local 驱动 → 写本地成功，且本地目录**必须出现文件**
 */
describe('生成图的写入落点按驱动走', () => {
  const stubProvider: ImageProvider = {
    name: 'stub',
    generate: async (): Promise<GeneratedImage> => ({
      buffer: Buffer.from('stub-bytes'),
      mimeType: 'image/png',
      width: 1,
      height: 1,
    }),
  }

  function installRuntime(provider: ImageProvider) {
    const g = globalThis as unknown as { __motifRuntime?: unknown }
    g.__motifRuntime = {
      store,
      provider,
      mailer: { mailer: { name: 'stub', sendVerificationCode: async () => {} }, isConsole: true },
      dataDir: dir,
    }
  }

  /** 本地 storage 目录下的文件数（目录不存在算 0） */
  function localFileCount(): number {
    try {
      let n = 0
      const walk = (d: string) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          if (e.isDirectory()) walk(join(d, e.name))
          else n += 1
        }
      }
      walk(join(dir, 'storage'))
      return n
    } catch {
      return 0
    }
  }

  async function runOneGeneration() {
    installRuntime(stubProvider)
    const user = store.createUser({ email: `w-${Date.now()}@b.co`, passwordHash: 'h', name: 'w', credits: 4 })
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
    return res
  }

  it('local 驱动：生成图落到本地盘，消息完成', async () => {
    const res = await runOneGeneration()
    expect(store.getMessage(res.messageId)!.status).toBe('completed')
    expect(localFileCount()).toBe(1)
  })

  it('⚠️ 回归：s3 驱动下生成图**不许**写本地盘（远端不可达时消息应失败，本地目录仍为空）', async () => {
    writeSettings(store, { STORAGE_DRIVER: 's3', ...UNREACHABLE }, { danger: false })
    const res = await runOneGeneration()
    // 写远端失败 → 消息失败（而不是「悄悄写进本地盘、消息照常 completed」）
    expect(store.getMessage(res.messageId)!.status).toBe('failed')
    expect(localFileCount()).toBe(0)
  })
})
