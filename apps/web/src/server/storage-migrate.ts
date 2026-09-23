import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { storagePathFor } from '@motif/db'
import { createStorageFromConfig, type Storage } from './storage'

/**
 * 本地 → 远端的一次性搬迁。CLI（`scripts/storage-migrate.mjs`）只是薄壳，
 * 逻辑放这里以便单测（scripts/*.mjs 进不了 vitest 的 `@/` 别名）。
 */
export interface MigratePlan {
  /** 本地扫描到的对象总数 */
  total: number
  /** 需要上传的 key（远端已存在的不在内） */
  pending: string[]
  /** 远端已存在、本次跳过的 key */
  skipped: string[]
  /** DB 里已无记录、因此**不搬**的孤儿对象（本地残留；#58） */
  orphaned: string[]
}

/**
 * 枚举本地 storage 目录下所有对象。
 * key = 相对 `dataDir/storage` 的路径 —— 与 `storagePathFor` 拼出来的 `imageKey` 同构，
 * 所以搬迁不需要查库、不需要额外映射表。
 */
export function listLocalKeys(dataDir: string): string[] {
  const root = join(dataDir, 'storage')
  const out: string[] = []
  const walk = (dir: string) => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return // 目录不存在 = 没有本地图片（全新部署切 s3 的正常情况）
    }
    for (const name of entries) {
      const abs = join(dir, name)
      if (statSync(abs).isDirectory()) walk(abs)
      else out.push(relative(root, abs).split(sep).join('/'))
    }
  }
  walk(root)
  return out.sort()
}

/**
 * 只算清单、不动数据。
 *
 * 「跳过远端已存在的 key」既是**幂等**保证，也是**断点续跑**的实现：中断后重跑时，
 * 已上传的部分天然落在 skipped 里，不需要额外的断点文件或游标。
 *
 * `liveKeys`（#58）：DB 里**仍在册**的 imageKey 集合。给了它就只搬在册对象 ——
 * 否则「DB 行已删、本地文件残留」的孤儿会被当成「远端没有 → 待上传」而**重新上传**，
 * 桶里持续堆积（行已删、UI 也看不见，纯属垃圾）。不传则行为与从前完全一致（单测钉住这条）。
 */
export async function planMigration(
  dataDir: string,
  remote: Storage,
  liveKeys?: ReadonlySet<string>
): Promise<MigratePlan> {
  const all = listLocalKeys(dataDir)
  const orphaned = liveKeys ? all.filter((key) => !liveKeys.has(key)) : []
  const keys = liveKeys ? all.filter((key) => liveKeys.has(key)) : all
  const pending: string[] = []
  const skipped: string[] = []
  for (const key of keys) {
    if (await remote.exists(key)) skipped.push(key)
    else pending.push(key)
  }
  return { total: all.length, pending, skipped, orphaned }
}

/**
 * 执行搬迁。逐个 await：**失败即中断**（不吞错），下次重跑自动从缺口续上。
 * 已存在的对象**不覆盖** —— 远端那份可能已经是更新过的内容，搬迁不该反向回退它。
 */
export async function runMigration(
  dataDir: string,
  remote: Storage,
  onProgress?: (done: number, total: number, key: string) => void,
  liveKeys?: ReadonlySet<string>
): Promise<{ uploaded: number; skipped: number; orphaned: number }> {
  const plan = await planMigration(dataDir, remote, liveKeys)
  let done = 0
  for (const key of plan.pending) {
    await remote.write(key, readFileSync(storagePathFor(dataDir, key)))
    done += 1
    onProgress?.(done, plan.pending.length, key)
  }
  return { uploaded: done, skipped: plan.skipped.length, orphaned: plan.orphaned.length }
}

/** `pruneOrphans` 的结果。两侧分开报，不合成一个「删了 N 个」—— 合并会掩盖单侧失败。 */
export interface PruneResult {
  /** 本次判定为孤儿、并**尝试**删除的 key（本地与远端都尝试了一遍） */
  candidates: string[]
  /** 尝试之后**本地**仍存在的 key */
  remainingLocal: string[]
  /** 尝试之后**远端**仍存在（或无法确认）的 key */
  remainingRemote: string[]
}

/**
 * 只算孤儿清单，**不碰远端**。
 *
 * 单独抽出来有两个用处：dry-run 在远端不可达时也能看清单；以及避开 `planMigration` 里
 * 那轮对**在册** key 的 `remote.exists` —— prune 只关心孤儿，那些往返纯属白打。
 */
export function listOrphans(dataDir: string, liveKeys: ReadonlySet<string>): string[] {
  return listLocalKeys(dataDir).filter((key) => !liveKeys.has(key))
}

/**
 * 回查哪些 key 还在。
 * `exists` 抛错一律按「还在」算 —— **确认不了就不该声称删掉了**，这是删数据场景该有的保守口径。
 */
async function stillThere(storage: Storage, keys: string[]): Promise<string[]> {
  const out: string[] = []
  for (const key of keys) {
    try {
      if (await storage.exists(key)) out.push(key)
    } catch {
      out.push(key)
    }
  }
  return out
}

/**
 * 清掉孤儿对象（#61）：`planMigration` 只算不删，这里才是真正动手的地方。
 *
 * ⚠️ **这是删数据的运维动作**，故比搬迁多两道闸：
 * 1. `assertPruneSafe` 的空库拒绝（见上）；
 * 2. 只有显式传了 `--prune-orphans` 才会被调到（CLI 侧把关，见 `scripts/storage-migrate.mjs`）。
 *
 * 孤儿来源是**本地扫描**：`listOrphans` = `listLocalKeys - liveKeys`。所以「只在桶里、本地没有副本」
 * 的对象扫不出来 —— 搬迁是复制不是移动，正常流程下本地是超集，故这个限制只在有人手工删过本地
 * 文件时才会碰到。
 *
 * 删除两侧都试，各自 best-effort（与 `removeFromAllStorages` 同语义）：单侧失败不中断整批。
 * **两侧都回查**并如实回报 —— 早期版本只回查本地，于是「远端一个都没删掉」时会打印
 * 「清理完成」并以 0 退出，等于谎报干净。
 */
export async function pruneOrphans(
  dataDir: string,
  remote: Storage,
  liveKeys: ReadonlySet<string>,
  opts: {
    onProgress?: (done: number, total: number, key: string) => void
    /** 越过「孤儿占比过高」闸（CLI 的 `--force-prune`）。空库闸不可越过。 */
    force?: boolean
  } = {}
): Promise<PruneResult> {
  assertPruneSafe(dataDir, liveKeys, opts.force ?? false)

  const orphaned = listOrphans(dataDir, liveKeys)
  const local = createStorageFromConfig({ STORAGE_DRIVER: 'local' }, dataDir)
  let done = 0
  for (const key of orphaned) {
    try {
      await local.remove(key)
    } catch {
      // 本地删失败：留着，由下面的 remainingLocal 如实报出来
    }
    try {
      await remote.remove(key)
    } catch {
      // 远端可能不可达/无权限 —— 不该因此中断整批，但必须由 remainingRemote 报出来
    }
    done += 1
    opts.onProgress?.(done, orphaned.length, key)
  }

  return {
    candidates: orphaned,
    remainingLocal: await stillThere(local, orphaned),
    remainingRemote: await stillThere(remote, orphaned),
  }
}

/**
 * 清理孤儿被安全闸拦下时抛的错。
 *
 * 单独一个类型是为了让 CLI 能区分「拒绝执行」与「存储层故障」——
 * 否则拒绝会走到通用兜底，打出一句「请检查端点、桶与凭据、网络可达性」的错提示，
 * 把人往网络/凭据的方向带，而真正的原因是指错了库。
 */
export class PruneRefusedError extends Error {
  readonly name = 'PruneRefusedError'
}

/** 触发「孤儿占比过高」闸的最少孤儿数（低于它就不拦：小规模清理是日常操作） */
const ORPHAN_GUARD_MIN = 10
/** 触发占比闸的比例（严格大于才拦） */
const ORPHAN_GUARD_RATIO = 0.5

/**
 * 清理孤儿前的**安全闸**（#61）。两道，都抛 `PruneRefusedError`：
 *
 * 1. **空库**：`liveKeys` 为空却扫到本地对象 —— 几乎一定是 dataDir 指错、连到了空库。
 * 2. **孤儿占比过高**：孤儿 ≥10 个且占比 >50%。这道是为了兜住第 1 道拦不住的情况 ——
 *    `liveKeys` **非空但来自另一个/陈旧的库**（恢复了一份备份库、或 `MOTIF_DB_FILE` 与
 *    `MOTIF_DATA_DIR` 指向不一致），此时整个存储目录都会被判成孤儿。比例异常是唯一能在
 *    不看库内容的前提下察觉「这个库不像这份存储的主人」的信号。
 *    确认无误可加 `--force-prune` 越过（`force = true`）。
 *
 * 抽成独立函数是为了让 `--prune-orphans --dry-run` 也走同一道闸 —— 否则「连错库」时
 * dry-run 会打出一份「全库对象都是孤儿」的清单，看着像正常输出，去掉 `--dry-run` 就清空了。
 * 返回本地对象总数，省掉调用方再扫一次。
 */
export function assertPruneSafe(dataDir: string, liveKeys: ReadonlySet<string>, force = false): number {
  const all = listLocalKeys(dataDir)
  if (liveKeys.size === 0 && all.length > 0) {
    throw new PruneRefusedError(
      `拒绝清理孤儿：数据库里没有任何在册对象，本地却扫到 ${all.length} 个。` +
        '这通常意味着 dataDir / 数据库文件指错了地方，而不是「所有对象都成了孤儿」。' +
        '按孤儿删会把整个存储目录清空且不可恢复，故中止。请先确认配置指向正确的库。'
    )
  }
  const orphans = all.filter((key) => !liveKeys.has(key))
  const ratio = all.length > 0 ? orphans.length / all.length : 0
  if (!force && orphans.length >= ORPHAN_GUARD_MIN && ratio > ORPHAN_GUARD_RATIO) {
    throw new PruneRefusedError(
      `拒绝清理孤儿：本次会删掉 ${orphans.length}/${all.length} 个本地对象（${Math.round(ratio * 100)}%），比例过高。` +
        '数据库里在册的对象与这份存储目录对不上时（例如恢复了一份旧备份库、' +
        '或 MOTIF_DB_FILE 与 MOTIF_DATA_DIR 指向不一致），孤儿占比就会异常高。' +
        '若你已确认数据库指向正确、且这些对象确实都该删，请加 --force-prune 再跑一次。'
    )
  }
  return all.length
}
