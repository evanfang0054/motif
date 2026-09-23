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

/** `pruneOrphans` 的结果。两侧语义不同，故意分开报，不合成一个「删了 N 个」。 */
export interface PruneResult {
  /** 本次判定为孤儿、并**尝试**删除的 key（本地与远端都尝试了一遍） */
  candidates: string[]
  /** 尝试之后**本地**仍存在的 key —— 远端不回查：不可达时会把全部误报成残留 */
  remainingLocal: string[]
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

/**
 * 清理孤儿前的**安全闸**（#61）：`liveKeys` 为空却扫到本地对象时抛错。
 *
 * 抽成独立函数是为了让 `--prune-orphans --dry-run` 也走同一道闸 —— 否则「连错库」时
 * dry-run 会打出一份「全库对象都是孤儿」的清单，看着像正常输出，去掉 `--dry-run` 就清空了。
 * 返回本地对象总数，省掉调用方再扫一次。
 */
export function assertPruneSafe(dataDir: string, liveKeys: ReadonlySet<string>): number {
  const all = listLocalKeys(dataDir)
  if (liveKeys.size === 0 && all.length > 0) {
    throw new PruneRefusedError(
      `拒绝清理孤儿：数据库里没有任何在册对象，本地却扫到 ${all.length} 个。` +
        '这通常意味着 dataDir / 数据库文件指错了地方，而不是「所有对象都成了孤儿」。' +
        '按孤儿删会把整个存储目录清空且不可恢复，故中止。请先确认配置指向正确的库。'
    )
  }
  return all.length
}

/**
 * 清掉孤儿对象（#61）：`planMigration` 只算不删，这里才是真正动手的地方。
 *
 * ⚠️ **这是删数据的运维动作**，故比搬迁多两道闸：
 * 1. `assertPruneSafe` 的空库拒绝（见上）；
 * 2. 只有显式传了 `--prune-orphans` 才会被调到（CLI 侧把关，见 `scripts/storage-migrate.mjs`）。
 *
 * 孤儿来源是**本地扫描**：`orphaned = listLocalKeys - liveKeys`。所以「只在桶里、本地没有副本」
 * 的对象扫不出来 —— 搬迁是复制不是移动，正常流程下本地是超集，故这个限制只在有人手工删过本地
 * 文件时才会碰到。
 *
 * 删除两侧都试，各自 best-effort（与 `removeFromAllStorages` 同语义）：单侧失败不中断整批，
 * 真结果由 `remainingLocal` 如实回给调用方。
 */
export async function pruneOrphans(
  dataDir: string,
  remote: Storage,
  liveKeys: ReadonlySet<string>,
  onProgress?: (done: number, total: number, key: string) => void
): Promise<PruneResult> {
  assertPruneSafe(dataDir, liveKeys)

  const { orphaned } = await planMigration(dataDir, remote, liveKeys)
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
      // 远端可能不可达 —— 不该因此中断整批（与删除路径同语义）
    }
    done += 1
    onProgress?.(done, orphaned.length, key)
  }

  const remainingLocal: string[] = []
  for (const key of orphaned) if (await local.exists(key)) remainingLocal.push(key)
  return { candidates: orphaned, remainingLocal }
}
