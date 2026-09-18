import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MotifStore } from '@motif/db'
import type { GeneratedImage, ImageProvider } from '@motif/image-provider'
import { enqueueGeneration } from '@/server/services'
import { getRuntime, invalidateRuntime } from '@/server/context'
import { runWorkerTick, type WorkerState } from '@/server/worker'
import { writeSettings } from '@/server/settings'

let dir: string
let store: MotifStore

function recordingProvider(tag: string, calls: string[]): ImageProvider {
  return {
    name: tag,
    generate: async (): Promise<GeneratedImage> => {
      calls.push(tag)
      return { buffer: Buffer.from('stub'), mimeType: 'image/png', width: 1, height: 1 }
    },
  }
}

function installRuntime(provider: ImageProvider): void {
  const g = globalThis as unknown as { __motifRuntime?: unknown }
  g.__motifRuntime = {
    store,
    provider,
    mailer: { mailer: { name: 'stub', sendVerificationCode: async () => {} }, isConsole: true },
    dataDir: dir,
  }
}

function makeState(): WorkerState {
  return { store, dataDir: dir, workerId: 'worker-test', busy: false, timer: null, inFlight: new Set<string>() }
}

async function enqueueOne(email: string): Promise<void> {
  const user = store.createUser({ email, passwordHash: 'h', name: 'r', credits: 4 })
  await enqueueGeneration(store, recordingProvider('unused', []), dir, user, {
    prompt: '晨光中的白瓷马克杯',
    count: 1,
    size: '1024x1024',
    enhance: false,
    topicId: null,
    referenceCanvasImageIds: [],
  })
}

function clearRuntime(): void {
  delete (globalThis as unknown as { __motifRuntime?: unknown }).__motifRuntime
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'motif-settings-runtime-'))
  store = new MotifStore(join(dir, 't.db'))
})

afterEach(() => {
  const g = globalThis as unknown as { __motifRuntime?: unknown; __motifWorker?: unknown }
  delete g.__motifRuntime
  delete g.__motifWorker
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('运行时重建', () => {
  it('未触发失效时，重复获取运行时返回同一实例', () => {
    installRuntime(recordingProvider('p1', []))
    expect(getRuntime()).toBe(getRuntime())
  })

  it('invalidateRuntime 后 provider 与 mailer 是新实例，store 与 dataDir 不变', () => {
    installRuntime(recordingProvider('p1', []))
    const rt = getRuntime()
    // ⚠️ 必须在失效前把旧 provider 存下来。失效是**原地改字段**，getRuntime() 返回的还是同一个
    // runtime 对象；若写成 `const rt1 = getRuntime(); invalidateRuntime(); const rt2 = getRuntime()`
    // 再去比 rt2.provider !== rt1.provider，比的是「自己和自己」，永远红。
    const oldProvider = rt.provider
    const oldMailer = rt.mailer
    invalidateRuntime()
    expect(rt.provider).not.toBe(oldProvider)
    expect(rt.mailer).not.toBe(oldMailer)
    expect(rt.store).toBe(store) // ⚠️ worker 持有它，换掉会让 worker 写旧连接
    expect(rt.dataDir).toBe(dir)
  })

  it('连续多次失效后 store 与 dataDir 仍保持不变（幂等）', () => {
    installRuntime(recordingProvider('p1', []))
    const rt = getRuntime()
    invalidateRuntime()
    invalidateRuntime()
    invalidateRuntime()
    expect(rt.store).toBe(store)
    expect(rt.dataDir).toBe(dir)
    expect(getRuntime()).toBe(rt) // 原地改字段：runtime 对象本身始终是同一个
  })

  it('配置齐全后新 provider 是按新配置构造的（DB 的值压过 env）', () => {
    // ⚠️ 刻意**不**让 getRuntime() 自己建库：那样它会按 MOTIF_DATA_DIR 去开 motif.db，
    // 而本用例的 store 在 t.db —— 改的是 t.db、读的是 motif.db，断言会永远红。
    // 注入 runtime 让「被读的 store」与「被写的 store」确定是同一个。
    const saved = { a: process.env.IMAGE_API_BASE_URL, b: process.env.IMAGE_API_KEY, m: process.env.IMAGE_MODEL }
    process.env.IMAGE_API_BASE_URL = 'http://old.example/v1'
    process.env.IMAGE_API_KEY = 'old-key'
    process.env.IMAGE_MODEL = 'old-model'
    const old = recordingProvider('old-model', [])
    installRuntime(old)
    try {
      expect(getRuntime().provider).toBe(old)
      // 库里的值才是真相：只改库、不改 env，失效后必须用新模型
      store.setSetting('IMAGE_MODEL', 'new-model')
      invalidateRuntime()
      const after = getRuntime().provider
      expect(after).not.toBe(old)
      expect(after.name).toBe('new-model')
    } finally {
      clearRuntime()
      if (saved.a) process.env.IMAGE_API_BASE_URL = saved.a
      else delete process.env.IMAGE_API_BASE_URL
      if (saved.b) process.env.IMAGE_API_KEY = saved.b
      else delete process.env.IMAGE_API_KEY
      if (saved.m) process.env.IMAGE_MODEL = saved.m
      else delete process.env.IMAGE_MODEL
    }
  })

  it('清空一个影响运行时的键后同样重建（删除也是配置变更）', () => {
    const saved = { a: process.env.IMAGE_API_BASE_URL, b: process.env.IMAGE_API_KEY, m: process.env.IMAGE_MODEL }
    process.env.IMAGE_API_BASE_URL = 'http://gw.example/v1'
    process.env.IMAGE_API_KEY = 'k'
    delete process.env.IMAGE_MODEL // 清空后要回落到构造器默认值，所以 env 里也不能有它
    store.setSetting('IMAGE_MODEL', 'db-model')
    const old = recordingProvider('db-model', [])
    installRuntime(old)
    try {
      expect(getRuntime().provider.name).toBe('db-model')
      writeSettings(store, { IMAGE_MODEL: '' }, { danger: false }) // 清空 = 删行
      invalidateRuntime()
      // 回落到构造器默认值，而不是还挂着旧模型
      expect(getRuntime().provider.name).toBe('gpt-image-2')
      expect(getRuntime().provider).not.toBe(old)
    } finally {
      clearRuntime()
      if (saved.a) process.env.IMAGE_API_BASE_URL = saved.a
      else delete process.env.IMAGE_API_BASE_URL
      if (saved.b) process.env.IMAGE_API_KEY = saved.b
      else delete process.env.IMAGE_API_KEY
      if (saved.m) process.env.IMAGE_MODEL = saved.m
      else delete process.env.IMAGE_MODEL
    }
  })

  it('配置缺失时不抛错，而是拿到 unconfigured 占位 provider', () => {
    // 隔离：清掉全部生图 env；同时钉住数据库路径，别让 getRuntime 去开 motif.db
    const saved = {
      a: process.env.IMAGE_API_BASE_URL,
      b: process.env.IMAGE_API_KEY,
      c: process.env.MOTIF_DATA_DIR,
      d: process.env.MOTIF_DB_FILE,
    }
    process.env.MOTIF_DATA_DIR = dir
    process.env.MOTIF_DB_FILE = join(dir, 'runtime.db')
    delete process.env.IMAGE_API_BASE_URL
    delete process.env.IMAGE_API_KEY
    clearRuntime()
    try {
      // 正对照：这正是修复前会抛错的那条路径
      expect(() => getRuntime()).not.toThrow()
      expect(getRuntime().provider.name).toBe('unconfigured')
    } finally {
      getRuntime().store.close() // runtime 自己开的连接要显式关，否则句柄活过 rmSync(dir)
      clearRuntime()
      if (saved.a) process.env.IMAGE_API_BASE_URL = saved.a
      if (saved.b) process.env.IMAGE_API_KEY = saved.b
      if (saved.c) process.env.MOTIF_DATA_DIR = saved.c
      else delete process.env.MOTIF_DATA_DIR
      if (saved.d) process.env.MOTIF_DB_FILE = saved.d
      else delete process.env.MOTIF_DB_FILE
    }
  })

  it('占位 provider 真正发起生成时抛错，且错误指向设置页', async () => {
    const saved = {
      a: process.env.IMAGE_API_BASE_URL,
      b: process.env.IMAGE_API_KEY,
      c: process.env.MOTIF_DATA_DIR,
      d: process.env.MOTIF_DB_FILE,
    }
    process.env.MOTIF_DATA_DIR = dir
    process.env.MOTIF_DB_FILE = join(dir, 'runtime2.db')
    delete process.env.IMAGE_API_BASE_URL
    delete process.env.IMAGE_API_KEY
    clearRuntime()
    try {
      await expect(
        getRuntime().provider.generate({
          prompt: 'x',
          size: '1024x1024',
          seedText: 's',
          referenceImages: [],
          indexInBatch: 0,
        })
      ).rejects.toThrow(/系统设置/)
    } finally {
      getRuntime().store.close()
      clearRuntime()
      if (saved.a) process.env.IMAGE_API_BASE_URL = saved.a
      if (saved.b) process.env.IMAGE_API_KEY = saved.b
      if (saved.c) process.env.MOTIF_DATA_DIR = saved.c
      else delete process.env.MOTIF_DATA_DIR
      if (saved.d) process.env.MOTIF_DB_FILE = saved.d
      else delete process.env.MOTIF_DB_FILE
    }
  })

  it('改了邮件渠道后 mailer 按新配置重建', () => {
    const saved = { c: process.env.MOTIF_DATA_DIR, d: process.env.MOTIF_DB_FILE }
    process.env.MOTIF_DATA_DIR = dir
    process.env.MOTIF_DB_FILE = join(dir, 't.db')
    clearRuntime()
    try {
      expect(getRuntime().mailer.mailer.name).toBe('console')
      store.setSetting('MOTIF_MAILER', 'smtp')
      store.setSetting('SMTP_HOST', 'smtp.example')
      store.setSetting('SMTP_PORT', '465')
      store.setSetting('SMTP_USER', 'u@example.com')
      store.setSetting('SMTP_PASS', 'p')
      store.setSetting('MAIL_FROM', 'u@example.com')
      invalidateRuntime()
      expect(getRuntime().mailer.mailer.name).toBe('smtp')
    } finally {
      getRuntime().store.close()
      clearRuntime()
      if (saved.c) process.env.MOTIF_DATA_DIR = saved.c
      else delete process.env.MOTIF_DATA_DIR
      if (saved.d) process.env.MOTIF_DB_FILE = saved.d
      else delete process.env.MOTIF_DB_FILE
    }
  })

  it('发信配置写坏时不抛错，但 isConsole 为 false（绝不直出验证码）', () => {
    store.setSetting('MOTIF_MAILER', 'smtp') // 缺 SMTP_HOST 等
    installRuntime(recordingProvider('p1', []))
    invalidateRuntime()
    const mailer = getRuntime().mailer
    expect(mailer.mailer.name).toBe('misconfigured')
    expect(mailer.isConsole).toBe(false)
  })
})

describe('worker 取用当前 provider（热重载的最后一公里）', () => {
  it('替换 runtime 的 provider 后，下一个轮次用的是新实例', async () => {
    const calls: string[] = []
    const p1 = recordingProvider('p1', calls)
    const p2 = recordingProvider('p2', calls)
    installRuntime(p1)
    const state = makeState()

    await enqueueOne('w1@b.co')
    await runWorkerTick(state)
    expect(calls).toEqual(['p1']) // 正对照：第一轮确实用 p1

    // 模拟热重载：runtime 里的 provider 被换掉
    installRuntime(p2)
    await enqueueOne('w2@b.co')
    await runWorkerTick(state)
    // 若 worker 仍旧快照启动时的 provider，这里会是 ['p1','p1'] —— 这条断言就是用来抓它的
    expect(calls).toEqual(['p1', 'p2'])
  })
})
