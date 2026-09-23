import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { MotifStore, storagePathFor } from '@motif/db'
import { removeFromAllStorages } from '@/server/context'
import { planMigration, runMigration } from '@/server/storage-migrate'
import { writeSettings } from '@/server/settings'
import type { Storage } from '@/server/storage'

/**
 * #58：删除图片时两侧都清；搬迁只搬数据库里仍在册的对象。
 *
 * 两条都做反向证明：删除那条把远端指向必然不可达的端点（旧实现只删远端 → 本地残留会变红）；
 * 搬迁那条则证明「不传 liveKeys 时孤儿**会**被重新上传」—— 否则「跳过孤儿」的断言可能恒真。
 */

// ---------- #58：搬迁只搬在册对象 ----------

/** 只记调用的假远端：exists 按传入的白名单回答，write 记录被上传的 key */
function fakeRemote(existing: string[] = []): { storage: Storage; writes: string[] } {
  const writes: string[] = []
  return {
    writes,
    storage: {
      read: async () => {
        throw new Error('测试用假远端不支持 read')
      },
      write: async (key: string) => {
        writes.push(key)
      },
      remove: async () => {},
      exists: async (key: string) => existing.includes(key),
    },
  }
}

describe('#58 planMigration：只搬 DB 里仍在册的对象', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'motif-migrate-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** 造两个本地对象：一个在册、一个已删（孤儿） */
  function seedTwo() {
    for (const key of ['u1/live.png', 'u1/deleted.png']) {
      const abs = storagePathFor(dir, key)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, 'bytes')
    }
  }

  it('给了 liveKeys → 孤儿不进 pending，且被记进 orphaned（total 仍含它）', async () => {
    seedTwo()
    const plan = await planMigration(dir, fakeRemote().storage, new Set(['u1/live.png']))
    expect(plan.pending).toEqual(['u1/live.png'])
    expect(plan.orphaned).toEqual(['u1/deleted.png'])
    expect(plan.total).toBe(2)
  })

  it('⚠️ 反证：**不传** liveKeys 时孤儿仍进 pending —— 证明这个参数真的在起作用', async () => {
    seedTwo()
    const plan = await planMigration(dir, fakeRemote().storage)
    expect(plan.pending).toEqual(['u1/deleted.png', 'u1/live.png'])
    expect(plan.orphaned).toEqual([])
  })

  it('runMigration 也透传：孤儿不会被重新上传回桶里', async () => {
    seedTwo()
    const remote = fakeRemote()
    const r = await runMigration(dir, remote.storage, undefined, new Set(['u1/live.png']))
    expect(remote.writes).toEqual(['u1/live.png'])
    expect(r).toEqual({ uploaded: 1, skipped: 0, orphaned: 1 })
  })

  it('反证：runMigration 不传 liveKeys 时孤儿**会**被上传（这就是 #58 的复传）', async () => {
    seedTwo()
    const remote = fakeRemote()
    await runMigration(dir, remote.storage)
    expect(remote.writes).toEqual(['u1/deleted.png', 'u1/live.png'])
  })
})

// ---------- #58：删除时两侧都清 ----------

describe('#58 removeFromAllStorages：两侧都清', () => {
  let dir: string
  let store: MotifStore
  const KEY = 'users/u1/topics/t1/a.png'

  /** 指向必然不可达的端点：远端删除会失败，正好验证「best-effort 不抛」 */
  const UNREACHABLE = {
    S3_ENDPOINT: 'http://127.0.0.1:9',
    S3_BUCKET: 'motif-test',
    S3_ACCESS_KEY_ID: 'k',
    S3_SECRET_ACCESS_KEY: 's',
    S3_FORCE_PATH_STYLE: 'true',
  }

  function seedLocal() {
    const abs = storagePathFor(dir, KEY)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, 'bytes')
  }

  function installRuntime() {
    const g = globalThis as unknown as { __motifRuntime?: unknown }
    g.__motifRuntime = {
      store,
      provider: { name: 'stub', generate: async () => ({}) },
      mailer: { mailer: { name: 'stub', sendVerificationCode: async () => {} }, isConsole: true },
      dataDir: dir,
    }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'motif-delboth-'))
    store = new MotifStore(join(dir, 'motif.db'))
    process.env.MOTIF_DATA_DIR = dir
    delete (globalThis as unknown as { __motifRuntime?: unknown }).__motifRuntime
    installRuntime()
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
    delete (globalThis as unknown as { __motifRuntime?: unknown }).__motifRuntime
    delete process.env.MOTIF_DATA_DIR
  })

  it('local 驱动：删掉本地那份', async () => {
    seedLocal()
    expect(existsSync(storagePathFor(dir, KEY))).toBe(true)
    await removeFromAllStorages(KEY)
    expect(existsSync(storagePathFor(dir, KEY))).toBe(false)
  })

  it('⚠️ 回归：s3 驱动下**本地那份也必须被清掉**（旧实现只删远端 → 本地残留）', async () => {
    writeSettings(store, { STORAGE_DRIVER: 's3', ...UNREACHABLE }, { danger: false })
    seedLocal()
    // 远端不可达：远端那次删除会失败，但 best-effort 不该抛
    await expect(removeFromAllStorages(KEY)).resolves.toBeUndefined()
    // 关键断言：s3 驱动下本地文件同样被删（这正是 #58 的「只清当前驱动那一份」缺口）
    expect(existsSync(storagePathFor(dir, KEY))).toBe(false)
  })

  it('反证：本地那份确实是被这个函数删的（不调用时文件还在）', () => {
    seedLocal()
    expect(existsSync(storagePathFor(dir, KEY))).toBe(true)
  })

  it('⚠️ s3 驱动但凭据没填全（构造即抛）时，本地那份仍要被清掉且不抛', async () => {
    // 只把驱动切成 s3、不填 S3_*：resolveRemoteStorage() 会直接抛「缺少配置」。
    // 若构造不在 try 里，本地清理根本走不到 → 本地文件残留（正是 #58 的缺口）。
    writeSettings(store, { STORAGE_DRIVER: 's3' }, { danger: false })
    seedLocal()
    await expect(removeFromAllStorages(KEY)).resolves.toBeUndefined()
    expect(existsSync(storagePathFor(dir, KEY))).toBe(false)
  })
})
