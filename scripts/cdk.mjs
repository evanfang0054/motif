#!/usr/bin/env node
/**
 * Motif CDK 发放工具
 *
 * 用法：
 *   node scripts/cdk.mjs <CODE> <CREDITS>            # 新增一个 CDK
 *   node scripts/cdk.mjs --list                      # 查看全部 CDK
 *
 * 数据库位置与 apps/web 一致（MOTIF_DATA_DIR 或 apps/web/.data）。
 */
import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = process.env.MOTIF_DATA_DIR || join(root, 'apps/web/.data')
const dbFile = process.env.MOTIF_DB_FILE || join(dataDir, 'motif.db')

mkdirSync(dirname(dbFile), { recursive: true })
const db = new Database(dbFile)
db.pragma('journal_mode = WAL')

// 服务端 schema 由应用首次启动时创建；CLI 独立运行时自愈建表，消除顺序依赖
db.exec(`
  CREATE TABLE IF NOT EXISTS cdks (
    code TEXT PRIMARY KEY,
    credits INTEGER NOT NULL,
    redeemed_by TEXT,
    redeemed_at TEXT,
    revoked_at TEXT,
    created_at TEXT NOT NULL
  )
`)

// 旧库（本 CLI 早于 revoked_at 建过表）平滑迁移，失败即列已存在
try {
  db.exec('ALTER TABLE cdks ADD COLUMN revoked_at TEXT')
} catch {
  // 列已存在
}

const [code, credits] = process.argv.slice(2)

if (code === '--list') {
  const rows = db.prepare('SELECT code, credits, redeemed_by, redeemed_at, revoked_at, created_at FROM cdks ORDER BY created_at DESC').all()
  if (rows.length === 0) {
    console.log('（暂无 CDK）')
  } else {
    for (const r of rows) {
      const state = r.revoked_at ? '已作废' : r.redeemed_by ? `已兑换 by ${r.redeemed_by}` : '未兑换'
      console.log(`${r.code}  ${r.credits} 张  ${state}  创建于 ${r.created_at}`)
    }
  }
} else if (code && /^\d+$/.test(String(credits)) && Number(credits) > 0) {
  // 重新发放 = 彻底重置：必须一并清掉 revoked_at。
  // 兑换会拒绝已作废的码（redeemCdk），若只重置 redeemed_*，对已作废的码重新发放会「打印成功
  // 但拿到一张永远兑换不了的码」。
  db.prepare(
    `INSERT INTO cdks (code, credits, created_at) VALUES (?, ?, ?)
     ON CONFLICT(code) DO UPDATE SET credits = excluded.credits, redeemed_by = NULL, redeemed_at = NULL, revoked_at = NULL`
  ).run(String(code).toUpperCase(), Number(credits), new Date().toISOString())
  console.log(`✅ CDK 已发放：${String(code).toUpperCase()}（${Number(credits)} 张额度）`)
} else {
  console.log('用法：node scripts/cdk.mjs <CODE> <CREDITS> | --list')
  process.exitCode = 1
}

db.close()
