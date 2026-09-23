#!/usr/bin/env node
/**
 * Motif 图片存储搬迁：把本地 dataDir/storage 下的图片搬到远端（S3 兼容）。
 *
 * 用法：
 *   pnpm storage:migrate                      # 正式搬迁（可反复执行，已存在的不重复上传）
 *   pnpm storage:migrate --dry-run            # 只看清单，不动任何数据
 *   pnpm storage:migrate --prune-orphans --dry-run   # 只看「将被清理的孤儿」清单
 *   pnpm storage:migrate --prune-orphans      # ⚠️ 真删孤儿（本地与远端都删，不可恢复）
 *
 * 断点续跑：中断后直接重跑即可 —— 「远端已存在则跳过」天然构成断点，不需要断点文件。
 *
 * ⚠️ `--prune-orphans` 是**删数据**的动作，与搬迁互斥：给了它就只清孤儿、不搬。默认关。
 * ⚠️ 先 bootstrapConfig：S3 凭据的真相在 settings 表，不先播种就读不到库里已改的配置。
 * ⚠️ 用 tsx 跑而不是裸 node：仓库内部 import 无扩展名且用 `@/` 别名，Node 原生解析不了。
 */
const { bootstrapConfig } = await import('../apps/web/src/server/bootstrap-config.ts')
const { createStorageFromConfig, describeStorageError } = await import('../apps/web/src/server/storage.ts')
const { assertPruneSafe, planMigration, pruneOrphans, PruneRefusedError, runMigration } = await import(
  '../apps/web/src/server/storage-migrate.ts'
)
const { resolveConfigValues } = await import('../apps/web/src/server/settings.ts')
const { getRuntime } = await import('../apps/web/src/server/context.ts')

const dryRun = process.argv.includes('--dry-run')
const prune = process.argv.includes('--prune-orphans')

await bootstrapConfig()
const { store, dataDir } = getRuntime()
const values = resolveConfigValues(store, process.env)

if ((values.STORAGE_DRIVER || 'local').toLowerCase() !== 's3') {
  console.error('[motif] 当前存储驱动不是 s3，无需搬迁。请先在「系统设置 → 图片存储」选 s3 并保存。')
  process.exit(1)
}

let remote
try {
  remote = createStorageFromConfig(values, dataDir)
} catch (e) {
  // createStorageFromConfig 的文案自带 `[motif] ` 前缀，别再叠一层
  console.error(e instanceof Error ? e.message : String(e))
  console.error('请到管理后台「系统设置 → 图片存储」补全配置后重试。')
  process.exit(1)
}

// 远端不可达时给一句人话，而不是抛未捕获异常 + 栈
try {
  await main()
} catch (e) {
  // 安全闸拒绝不是存储层故障：只把原因说清楚，别叠「请检查端点/桶/凭据/网络」那套错提示
  if (e instanceof PruneRefusedError) {
    console.error(`[motif] ${e.message}`)
    process.exit(1)
  }
  // ⚠️ 用 describeStorageError 而不是 `e.message`：minio 的 S3Error 在服务端没回 <Message> 时
  // message 是空串，直接插值会打出「搬迁失败：」这种什么也没说的日志。
  console.error(`[motif] 搬迁失败：${describeStorageError(e)}`)
  console.error('请检查「系统设置 → 图片存储」的端点、桶与凭据，以及网络可达性。')
  process.exit(1)
}

async function main() {
// 只搬 DB 里仍在册的对象（#58）：本地残留的孤儿（行已删）不该被重新上传回桶里。
// #61 起 listAllImageKeys 也含暂存参考图 —— 否则刚上传的参考图会被当成孤儿。
const liveKeys = new Set(store.listAllImageKeys())

if (prune) {
  // 先过安全闸（空库 + 有本地对象 → 拒绝）：dry-run 也走，免得打出一份看着正常的全量清单
  assertPruneSafe(dataDir, liveKeys)
  if (dryRun) {
    const plan = await planMigration(dataDir, remote, liveKeys)
    if (!plan.orphaned.length) {
      console.log('[motif] 没有孤儿对象，无需清理。')
      process.exit(0)
    }
    console.log(`[motif] 将被清理的孤儿对象 ${plan.orphaned.length} 个（本地与远端都会删，不可恢复）：`)
    for (const key of plan.orphaned) console.log(`  ${key}`)
    console.log('[motif] --dry-run：未删除任何对象。去掉 --dry-run 才会真删。')
    process.exit(0)
  }
  const r = await pruneOrphans(dataDir, remote, liveKeys, (done, total, key) => {
    console.log(`[motif] ${done}/${total} ${key}`)
  })
  console.log(`[motif] 孤儿清理完成：尝试删除 ${r.candidates.length} 个。`)
  if (r.remainingLocal.length) {
    console.error(`[motif] ⚠️ 有 ${r.remainingLocal.length} 个本地对象没删掉（远端未回查，请自行确认）：`)
    for (const key of r.remainingLocal) console.error(`  ${key}`)
    process.exit(1)
  }
  process.exit(0)
}

if (dryRun) {
  const plan = await planMigration(dataDir, remote, liveKeys)
  console.log(
    `[motif] 待搬迁 ${plan.pending.length} 个对象（共扫描到 ${plan.total} 个，远端已存在 ${plan.skipped.length} 个将跳过）`
  )
  for (const key of plan.pending) console.log(`  ${key}`)
  if (plan.orphaned.length) {
    console.log(`[motif] 另有 ${plan.orphaned.length} 个对象已不在数据库中（不搬迁，可自行清理）：`)
    for (const key of plan.orphaned) console.log(`  ${key}`)
  }
  console.log('[motif] --dry-run：未上传任何对象。')
  process.exit(0)
}

const r = await runMigration(
  dataDir,
  remote,
  (done, total, key) => {
    console.log(`[motif] ${done}/${total} ${key}`)
  },
  liveKeys
)
console.log(
  `[motif] 搬迁完成：本次上传 ${r.uploaded} 个，跳过已存在 ${r.skipped} 个，跳过已删除 ${r.orphaned} 个。`
)
}
