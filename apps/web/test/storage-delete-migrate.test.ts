import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { MotifStore, storagePathFor } from '@motif/db'
import { removeFromAllStorages } from '@/server/context'
import { assertPruneSafe, planMigration, PruneRefusedError, pruneOrphans, runMigration } from '@/server/storage-migrate'
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

// ---------- #61：清理孤儿（--prune-orphans 的底层） ----------

describe('#61 pruneOrphans：只删孤儿、两侧都删、空库拒绝', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'motif-prune-'))
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
  const localExists = (key: string) => existsSync(storagePathFor(dir, key))

  it('【A1 安全门】liveKeys 为空且本地有对象 → 拒绝执行（连错库时不能把存储清空）', async () => {
    seedTwo()
    // 抛的是专用类型：CLI 靠它区分「拒绝执行」与「存储层故障」，避免打错提示
    await expect(pruneOrphans(dir, fakeRemote().storage, new Set())).rejects.toThrow(PruneRefusedError)
    await expect(pruneOrphans(dir, fakeRemote().storage, new Set())).rejects.toThrow(/拒绝清理孤儿/)
    // 关键：一个文件都没动
    expect(localExists('u1/live.png')).toBe(true)
    expect(localExists('u1/deleted.png')).toBe(true)
  })

  it('【A1】本地为空时不拒绝（没有可删的东西，空库也只是无事可做）', async () => {
    await expect(pruneOrphans(dir, fakeRemote().storage, new Set())).resolves.toEqual({
      candidates: [],
      remainingLocal: [],
    })
  })

  it('【A1】assertPruneSafe 单独可用（dry-run 也要走同一道闸）', () => {
    seedTwo()
    expect(() => assertPruneSafe(dir, new Set())).toThrow(PruneRefusedError)
    expect(assertPruneSafe(dir, new Set(['u1/live.png']))).toBe(2)
  })

  it('【A1 反证】liveKeys 非空时不拒绝 —— 证明这道闸是「空库」而非「有孤儿」在触发', async () => {
    seedTwo()
    const r = await pruneOrphans(dir, fakeRemote().storage, new Set(['u1/live.png']))
    expect(r.candidates).toEqual(['u1/deleted.png'])
  })

  it('【B1】只删孤儿：在册对象两侧都不动，孤儿两侧都删', async () => {
    seedTwo()
    const remote = fakeRemote()
    await remote.storage.write('u1/deleted.png', Buffer.from('x')) // 桶里也有一份
    const r = await pruneOrphans(dir, remote.storage, new Set(['u1/live.png']))

    expect(r.candidates).toEqual(['u1/deleted.png'])
    expect(r.remainingLocal).toEqual([])
    expect(localExists('u1/deleted.png')).toBe(false)
    expect(await remote.storage.exists('u1/deleted.png')).toBe(false)
    // 在册对象一个不动
    expect(localExists('u1/live.png')).toBe(true)
  })

  it('【B2】远端不可达不中断整批，本地那份照样删掉', async () => {
    seedTwo()
    const remote = {
      read: async () => {
        throw new Error('unreachable')
      },
      write: async () => {},
      remove: async () => {
        throw new Error('unreachable')
      },
      exists: async () => false,
    } as Storage
    await expect(pruneOrphans(dir, remote, new Set(['u1/live.png']))).resolves.toEqual({
      candidates: ['u1/deleted.png'],
      remainingLocal: [],
    })
    expect(localExists('u1/deleted.png')).toBe(false)
  })

  it('【B3】本地删不掉时如实报进 remainingLocal（不谎报「已清理」）', async () => {
    seedTwo()
    // 把孤儿的父目录设为只读 → unlinkSync 失败；localStorage.remove 吞掉异常，文件仍在
    const parent = dirname(storagePathFor(dir, 'u1/deleted.png'))
    chmodSync(parent, 0o555)
    try {
      const r = await pruneOrphans(dir, fakeRemote().storage, new Set(['u1/live.png']))
      expect(r.candidates).toEqual(['u1/deleted.png'])
      expect(r.remainingLocal).toEqual(['u1/deleted.png'])
      expect(localExists('u1/deleted.png')).toBe(true)
    } finally {
      chmodSync(parent, 0o755) // 让 afterEach 的 rmSync 能删掉
    }
  })

  it('【C2】搬迁路径不删任何对象 —— prune 是独立动作，不会顺带清东西', async () => {
    seedTwo()
    await runMigration(dir, fakeRemote().storage, undefined, new Set(['u1/live.png']))
    expect(localExists('u1/deleted.png')).toBe(true)
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
