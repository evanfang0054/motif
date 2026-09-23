import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { accessSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { MotifStore, storagePathFor } from '@motif/db'
import { removeFromAllStorages, removeManyFromAllStorages } from '@/server/context'
import { runBounded } from '@/server/bounded'
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

/**
 * 会记账的假远端：`write` / `remove` **真的**改内部集合，`exists` 据此回答。
 *
 * ⚠️ 早先这版 `exists` 只读构造时传入的白名单、不随 write/remove 变化 —— 于是
 * 「prune 之后远端也没有了」那条断言**恒为 true**，最危险的远端删除侧等于零覆盖。
 * 现在 `removes` 记下调用、`exists` 随 `remove` 变化，两条断言才都有牙齿。
 *
 * `present` 暴露出来是为了能模拟「桶配错」：那时 `remove` 抛错、`exists` 却返回 false
 * （HEAD 404 无 body → NoSuchBucket 也被当成 NotFound）。
 */
function fakeRemote(existing: string[] = []): {
  storage: Storage
  writes: string[]
  removes: string[]
  present: Set<string>
} {
  const present = new Set(existing)
  const writes: string[] = []
  const removes: string[] = []
  return {
    writes,
    removes,
    present,
    storage: {
      read: async () => {
        throw new Error('测试用假远端不支持 read')
      },
      write: async (key: string) => {
        present.add(key)
        writes.push(key)
      },
      remove: async (key: string) => {
        present.delete(key)
        removes.push(key)
      },
      exists: async (key: string) => present.has(key),
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
      remainingRemote: [],
    })
  })

  it('【A1 反证】liveKeys 非空时不拒绝 —— 证明这道闸是「空库」而非「有孤儿」在触发', async () => {
    seedTwo()
    const r = await pruneOrphans(dir, fakeRemote().storage, new Set(['u1/live.png']))
    expect(r.candidates).toEqual(['u1/deleted.png'])
  })

  it('【A1】assertPruneSafe 单独可用（dry-run 也要走同一道闸）', () => {
    seedTwo()
    expect(() => assertPruneSafe(dir, new Set())).toThrow(PruneRefusedError)
    expect(assertPruneSafe(dir, new Set(['u1/live.png']))).toBe(2)
  })

  it('【B1】只删孤儿：在册对象两侧都不动，孤儿两侧都删', async () => {
    seedTwo()
    const remote = fakeRemote()
    await remote.storage.write('u1/deleted.png', Buffer.from('x')) // 桶里也有一份
    expect(await remote.storage.exists('u1/deleted.png')).toBe(true) // 前提：假远端真的是有状态的
    const r = await pruneOrphans(dir, remote.storage, new Set(['u1/live.png']))

    expect(r.candidates).toEqual(['u1/deleted.png'])
    expect(r.remainingLocal).toEqual([])
    expect(r.remainingRemote).toEqual([])
    expect(localExists('u1/deleted.png')).toBe(false)
    // 关键：远端**确实收到了**这一条删除（不是「exists 恰好返回 false」）
    expect(remote.removes).toEqual(['u1/deleted.png'])
    expect(await remote.storage.exists('u1/deleted.png')).toBe(false)
    // 在册对象一个不动（本地留着、远端也从没被要求删）
    expect(localExists('u1/live.png')).toBe(true)
    expect(remote.removes).not.toContain('u1/live.png')
  })

  it('【B2】远端不可达不中断整批：本地删掉、远端如实报进 remainingRemote', async () => {
    seedTwo()
    const remote = {
      read: async () => {
        throw new Error('unreachable')
      },
      write: async () => {},
      remove: async () => {
        throw new Error('unreachable')
      },
      exists: async () => {
        throw new Error('unreachable')
      },
    } as Storage
    await expect(pruneOrphans(dir, remote, new Set(['u1/live.png']))).resolves.toEqual({
      candidates: ['u1/deleted.png'],
      remainingLocal: [],
      // 远端连 exists 都抛 → 保守口径算「没删掉」，不能声称清理完成
      remainingRemote: ['u1/deleted.png'],
    })
    expect(localExists('u1/deleted.png')).toBe(false)
  })

  it('⚠️【B2 回归闸】远端 remove 失败但 exists 说「不在」→ 仍必须报未确认（桶配错就是这种形态）', async () => {
    // 桶名配错时 statObject 走 HEAD、404 无 body → NoSuchBucket 也被当成 NotFound，
    // 于是 exists 返回 false。此时**唯一**能暴露问题的信号是 remove 抛的错。
    // 所以这里必须让 present 也丢掉该 key —— 否则 exists 会替我们报出来，这条用例就白测了。
    seedTwo()
    const remote = fakeRemote()
    await remote.storage.write('u1/deleted.png', Buffer.from('x'))
    remote.storage.remove = async (key: string) => {
      remote.present.delete(key) // 模拟「exists 说它不在」
      throw new Error('NoSuchBucket')
    }
    const r = await pruneOrphans(dir, remote.storage, new Set(['u1/live.png']))
    expect(r.remainingLocal).toEqual([]) // 本地删干净了
    expect(r.remainingRemote).toEqual(['u1/deleted.png']) // 但远端没确认 —— 不能报成干净
  })

  it('【B3】本地删不掉时如实报进 remainingLocal（不谎报「已清理」）', async () => {
    // ⚠️ 这个手法依赖「目录写权限真的能挡住 unlink」。root 无视目录权限、Windows 的 chmod
    // 基本是空操作 —— 那两种环境下断言必然失败，会变成**假红**。所以先探测，挡不住就跳过。
    if (process.getuid?.() === 0) {
      console.warn('[skip] 以 root 运行：目录权限挡不住 unlink，本用例无意义')
      return
    }
    seedTwo()
    // 把孤儿的父目录设为只读 → unlinkSync 失败；localStorage.remove 吞掉异常，文件仍在
    const parent = dirname(storagePathFor(dir, 'u1/deleted.png'))
    chmodSync(parent, 0o555)
    try {
      try {
        accessSync(parent, constants.W_OK)
        console.warn('[skip] chmod 未生效（平台不支持），本用例无意义')
        return
      } catch {
        // 预期路径：写权限确实被拿掉了
      }
      const r = await pruneOrphans(dir, fakeRemote().storage, new Set(['u1/live.png']))
      expect(r.candidates).toEqual(['u1/deleted.png'])
      expect(r.remainingLocal).toEqual(['u1/deleted.png'])
      expect(localExists('u1/deleted.png')).toBe(true)
    } finally {
      chmodSync(parent, 0o755) // 让 afterEach 的 rmSync 能删掉
    }
  })

  /**
   * 第 2 道闸：孤儿占比过高。
   * 空库闸拦不住「liveKeys 非空但来自另一个/陈旧的库」—— 那时整份存储都会被判成孤儿。
   */
  describe('【A2 安全门】孤儿占比过高 → 拒绝，需 --force-prune 越过', () => {
    /** 造 12 个对象：`liveCount` 个在册、其余为孤儿 */
    function seedMany(liveCount: number): Set<string> {
      const live = new Set<string>()
      for (let i = 0; i < 12; i++) {
        const key = `u1/k${i}.png`
        const abs = storagePathFor(dir, key)
        mkdirSync(dirname(abs), { recursive: true })
        writeFileSync(abs, 'bytes')
        if (i < liveCount) live.add(key)
      }
      return live
    }

    it('孤儿 12/12（100%）→ 拒绝，且一个文件都没动', async () => {
      const live = seedMany(0)
      live.add('u1/other-lib.png') // 非空但一个都不在这份存储里 —— 正是「错库」的形态
      await expect(pruneOrphans(dir, fakeRemote().storage, live)).rejects.toThrow(PruneRefusedError)
      await expect(pruneOrphans(dir, fakeRemote().storage, live)).rejects.toThrow(/比例过高/)
      expect(localExists('u1/k0.png')).toBe(true)
      expect(localExists('u1/k11.png')).toBe(true)
    })

    it('⚠️ 越过：force 时照删（确认过库没错的人要能推进）', async () => {
      const live = new Set(['u1/other-lib.png'])
      seedMany(0)
      const r = await pruneOrphans(dir, fakeRemote().storage, live, { force: true })
      expect(r.candidates).toHaveLength(12)
      expect(r.remainingLocal).toEqual([])
      expect(localExists('u1/k0.png')).toBe(false)
    })

    it('孤儿 12/24（50%）→ 不拦（阈值是「严格大于」）', async () => {
      const live = seedMany(12)
      for (let i = 0; i < 12; i++) {
        const key = `u1/extra${i}.png`
        const abs = storagePathFor(dir, key)
        mkdirSync(dirname(abs), { recursive: true })
        writeFileSync(abs, 'bytes')
      }
      const r = await pruneOrphans(dir, fakeRemote().storage, live)
      expect(r.candidates).toHaveLength(12)
    })

    it('孤儿只有 9 个（占比 100% 但未达最少个数）→ 不拦 —— 小规模清理不该被拦', async () => {
      // liveKeys 必须非空（否则先被空库闸拦下）；指向别处即可，本用例只关心占比闸
      const live = new Set(['u1/elsewhere.png'])
      for (let i = 0; i < 9; i++) {
        const key = `u1/s${i}.png`
        const abs = storagePathFor(dir, key)
        mkdirSync(dirname(abs), { recursive: true })
        writeFileSync(abs, 'bytes')
      }
      const r = await pruneOrphans(dir, fakeRemote().storage, live)
      expect(r.candidates).toHaveLength(9)
    })

    it('空库闸不可被 force 越过（错库必须拦住，不是「确认一下就能删」）', async () => {
      seedTwo()
      await expect(pruneOrphans(dir, fakeRemote().storage, new Set(), { force: true })).rejects.toThrow(/拒绝清理孤儿/)
      expect(localExists('u1/deleted.png')).toBe(true)
    })
  })

  it('【C2】搬迁路径不删任何对象 —— prune 是独立动作，不会顺带清东西', async () => {
    seedTwo()
    await runMigration(dir, fakeRemote().storage, undefined, new Set(['u1/live.png']))
    expect(localExists('u1/deleted.png')).toBe(true)
  })
})

// ---------- #61：删任务时批量清对象（有界并发） ----------

describe('#61 runBounded：并发度真的有界', () => {
  it('并发度不超过上限，且全部跑完才 resolve', async () => {
    let inFlight = 0
    let peak = 0
    let finished = 0
    const items = Array.from({ length: 50 }, (_, i) => i)
    await runBounded(items, 4, async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 1))
      inFlight -= 1
      finished += 1
    })
    expect(peak).toBe(4) // 不是 50（全铺开）也不是 1（串行）
    expect(finished).toBe(50)
    expect(inFlight).toBe(0)
  })

  it('并发上限大于条目数时不会多开 worker，也不漏项', async () => {
    const seen: number[] = []
    await runBounded([1, 2, 3], 8, async (n) => {
      seen.push(n)
    })
    expect(seen.sort()).toEqual([1, 2, 3])
  })

  it('空列表直接返回（不构造 worker）', async () => {
    let called = false
    await runBounded([], 4, async () => {
      called = true
    })
    expect(called).toBe(false)
  })

  it('⚠️ 并发度非有限数时抛错，而不是**静默一个都不跑**（NaN 会算出空 worker 数组）', async () => {
    const seen: number[] = []
    const task = async (n: number) => {
      seen.push(n)
    }
    for (const bad of [Number.NaN, 0, -5]) {
      await expect(runBounded([1, 2, 3], bad, task)).rejects.toThrow(RangeError)
    }
    expect(seen).toEqual([]) // 抛错时不该有副作用
  })
})

describe('#61 removeManyFromAllStorages：一批 key 都清掉', () => {
  let dir: string
  let store: MotifStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'motif-rmmany-'))
    store = new MotifStore(join(dir, 'motif.db'))
    ;(globalThis as unknown as { __motifRuntime?: unknown }).__motifRuntime = { store, dataDir: dir }
  })
  afterEach(() => {
    delete (globalThis as unknown as { __motifRuntime?: unknown }).__motifRuntime
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function seed(keys: string[]) {
    for (const key of keys) {
      const abs = storagePathFor(dir, key)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, 'bytes')
    }
  }

  it('超过并发上限的数量也全部删掉（50 个）', async () => {
    const keys = Array.from({ length: 50 }, (_, i) => `u1/t/topics/t/messages/m/generated/${i}.png`)
    seed(keys)
    await removeManyFromAllStorages(keys, dir)
    expect(keys.every((k) => !existsSync(storagePathFor(dir, k)))).toBe(true)
  })

  it('某个 key 的对象本来就不在也不报错（best-effort）', async () => {
    seed(['u1/a.png'])
    await expect(removeManyFromAllStorages(['u1/a.png', 'u1/missing.png'], dir)).resolves.toBeUndefined()
    expect(existsSync(storagePathFor(dir, 'u1/a.png'))).toBe(false)
  })

  it('空数组是 no-op', async () => {
    await expect(removeManyFromAllStorages([], dir)).resolves.toBeUndefined()
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
