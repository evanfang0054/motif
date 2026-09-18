#!/usr/bin/env node
/**
 * Motif 超级管理员凭据工具
 *
 * 用法：
 *   node scripts/admin.mjs --reset   # 重置 root 密码为新的随机强密码
 *   node scripts/admin.mjs --list    # 查看当前管理员账号
 *
 * 用途：root 的邮箱默认不可达（admin@motif.local），「忘记密码」自助流程对它无效，
 * 因此需要一个带数据库直连能力的恢复入口。
 *
 * 数据库位置与 apps/web 一致（MOTIF_DATA_DIR 或 apps/web/.data）。
 */
import Database from 'better-sqlite3'
import { randomBytes, scryptSync } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = process.env.MOTIF_DATA_DIR || join(root, 'apps/web/.data')
const dbFile = process.env.MOTIF_DB_FILE || join(dataDir, 'motif.db')

// —— 与服务端 apps/web/src/server/auth.ts 同格式：scrypt$<salt>$<hash>
function hashPassword(password) {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, 32).toString('hex')
  return `scrypt$${salt}$${hash}`
}

// —— 与 packages/core/src/security.ts 同字符集与同洗牌策略（两处必须保持同步）
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
const LOWER = 'abcdefghijkmnopqrstuvwxyz'
const DIGIT = '23456789'
const SYMBOL = '!@#$%^&*-_=+'
const ALL = UPPER + LOWER + DIGIT + SYMBOL

function pick(set) {
  return set[randomBytes(1)[0] % set.length]
}

function generateStrongPassword(length = 20) {
  const chars = [pick(UPPER), pick(LOWER), pick(DIGIT), pick(SYMBOL)]
  while (chars.length < length) chars.push(pick(ALL))
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomBytes(1)[0] % (i + 1)
    const t = chars[i]
    chars[i] = chars[j]
    chars[j] = t
  }
  return chars.join('')
}

mkdirSync(dataDir, { recursive: true })
const db = new Database(dbFile)
db.pragma('journal_mode = WAL')

// 自愈建表：本工具可能先于应用首次启动运行，不能假设 users/sessions 已存在
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
    name TEXT NOT NULL, avatar_url TEXT, role TEXT NOT NULL DEFAULT 'user',
    status TEXT NOT NULL DEFAULT 'active', must_change_password INTEGER NOT NULL DEFAULT 0,
    disabled_at TEXT, credits INTEGER NOT NULL DEFAULT 0, invite_code TEXT NOT NULL UNIQUE,
    invited_by TEXT, invited_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
  );
`)

// 自愈补列：库可能是「加列之前」的旧库 —— 此时上面的 CREATE TABLE IF NOT EXISTS 是 no-op，
// 而 --list 会查 status 列并抛 no such column。与 packages/db/src/schema.ts 的迁移保持一致。
for (const [name, ddl] of Object.entries({
  status: "status TEXT NOT NULL DEFAULT 'active'",
  must_change_password: 'must_change_password INTEGER NOT NULL DEFAULT 0',
  disabled_at: 'disabled_at TEXT',
})) {
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name)
  if (cols.includes(name)) continue
  try {
    db.exec(`ALTER TABLE users ADD COLUMN ${ddl}`)
  } catch {
    // 已存在或并发竞争：忽略
  }
}

const mode = process.argv[2]

if (mode === '--list') {
  const rows = db
    .prepare("SELECT email, name, role, status, created_at FROM users WHERE role IN ('admin','root') ORDER BY role DESC, created_at")
    .all()
  if (rows.length === 0) {
    console.log('（暂无管理员账号）')
  } else {
    for (const r of rows) {
      console.log(`${r.role.padEnd(5)}  ${r.email}  ${r.name}  ${r.status}  创建于 ${r.created_at}`)
    }
  }
} else if (mode === '--reset') {
  const rootUser = db.prepare("SELECT id, email FROM users WHERE role = 'root' ORDER BY created_at LIMIT 1").get()
  if (!rootUser) {
    console.error('❌ 未找到超级管理员账号。')
    console.error(`   数据库: ${dbFile}`)
    console.error('   请先启动一次应用完成引导（会自动创建 root），或确认 MOTIF_DATA_DIR 是否指向正确的数据目录。')
    process.exitCode = 1
  } else {
    const password = generateStrongPassword()
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = ? WHERE id = ?').run(
      hashPassword(password),
      new Date().toISOString(),
      rootUser.id
    )
    // 吊销该账号全部会话：改密后旧会话不得继续有效
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(rootUser.id)

    const file = join(dataDir, 'admin-credentials.txt')
    const tmp = `${file}.tmp`
    let written = false
    try {
      writeFileSync(
        tmp,
        `Motif 超级管理员凭据（由 admin:reset 重置）\n邮箱: ${rootUser.email}\n密码: ${password}\n重置时间: ${new Date().toISOString()}\n\n请登录后立即修改密码。\n`,
        { mode: 0o600 }
      )
      renameSync(tmp, file) // 同目录内 rename：原子替换，权限随 inode 保留
      written = true
    } catch (e) {
      console.error('❌ 凭据文件写入失败，请立即记录上面的密码:', e.message)
    } finally {
      // 失败时清除含明文密码的临时文件
      if (existsSync(tmp)) rmSync(tmp, { force: true })
    }

    console.log('✅ 已重置超级管理员密码')
    console.log(`   邮箱: ${rootUser.email}`)
    console.log(`   密码: ${password}`)
    console.log(`   凭据${written ? `已写入: ${file}` : '未写入（见上方错误，密码已在上面打印）'}`)
    console.log('   该账号全部会话已吊销，需重新登录。')
  }
} else {
  console.log('用法：node scripts/admin.mjs --reset | --list')
  process.exitCode = 1
}

db.close()
