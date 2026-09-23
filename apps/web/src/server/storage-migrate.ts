import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { storagePathFor } from '@motif/db'
import type { Storage } from './storage'

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
