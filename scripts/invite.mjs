#!/usr/bin/env node
/**
 * Motif 注册准入码发放工具
 *
 * 用法：
 *   node scripts/invite.mjs --create <N> [--note <文本>]   # 发放 N 个准入码
 *   node scripts/invite.mjs --list                         # 查看全部准入码
 *
 * 数据库位置与 apps/web 一致（MOTIF_DATA_DIR 或 apps/web/.data）。
 *
 * ⚠️ 刻意**不**照抄 `cdk.mjs` 的位置参数风格（`cdk <CODE> <CREDITS>`）：准入码由系统生成、
 * 不是调用方提供的值，没有对应的位置参数。只复用它的骨架（db 解析 / 自愈建表 / 输出风格）。
 */
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
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
  CREATE TABLE IF NOT EXISTS registration_invites (
    code TEXT PRIMARY KEY,
    note TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    used_by TEXT,
    used_at TEXT,
    revoked_at TEXT
  )
`)

// 与 packages/core/src/ids.ts 的 randomCode 同形态（10 位大写字母数字）。
// 这里自备一份：CLI 不能 import workspace 的 TS 源码。
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
function newCode() {
  const bytes = randomBytes(10)
  let out = ''
  for (let i = 0; i < 10; i++) out += ALPHABET[bytes[i] % ALPHABET.length]
  return out
}

const args = process.argv.slice(2)
const noteIdx = args.indexOf('--note')
const note = noteIdx >= 0 ? (args[noteIdx + 1] ?? '').trim() || null : null

if (args.includes('--list')) {
  const rows = db
    .prepare(
      'SELECT code, note, used_by, used_at, revoked_at, created_at FROM registration_invites ORDER BY created_at DESC, code DESC',
    )
    .all()
  if (rows.length === 0) {
    console.log('（暂无注册准入码）')
  } else {
    for (const r of rows) {
      const state = r.revoked_at ? '已作废' : r.used_by ? `已使用 by ${r.used_by}` : '未使用'
      console.log(`${r.code}  ${state}  ${r.note ?? '—'}  创建于 ${r.created_at}`)
    }
  }
} else if (args.includes('--create')) {
  const raw = args[args.indexOf('--create') + 1]
  const count = Number(raw)
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    console.log('用法：node scripts/invite.mjs --create <N> [--note <文本>] | --list（N 为 1–100 的整数）')
    process.exitCode = 1
  } else {
    const insert = db.prepare(
      'INSERT INTO registration_invites (code, note, created_by, created_at) VALUES (?, ?, ?, ?)',
    )
    const created = []
    const run = db.transaction(() => {
      for (let i = 0; i < count; i++) {
        let code = newCode()
        let inserted = false
        // 主键冲突换码重试（与 store.createRegistrationInviteBatch 同口径）
        for (let guard = 0; guard < 20 && !inserted; guard++) {
          try {
            insert.run(code, note, null, new Date().toISOString())
            inserted = true
          } catch {
            code = newCode()
          }
        }
        // ⚠️ 20 次都撞车就**抛错让整批回滚** —— 不能默默 push 一个没入库的码再打印「已发放」，
        //    那会打印出一个库里根本不存在的准入码（用户拿它去注册只会得到「无效或已被使用」）。
        if (!inserted) throw new Error('连续 20 次生成的主键都冲突，已回滚整批（未发放任何码）')
        created.push(code)
      }
    })
    run()
    for (const c of created) console.log(`✅ 注册准入码已发放：${c}`)
    if (note) console.log(`（备注：${note}）`)
  }
} else {
  console.log('用法：node scripts/invite.mjs --create <N> [--note <文本>] | --list')
  process.exitCode = 1
}

db.close()
