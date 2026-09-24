import type { Database } from 'better-sqlite3'

/** 表结构：用户 / 会话 / 验证码 / 任务 / 消息 / 画布图片 / CDK / 订单 / 反馈 */
export function applySchema(db: Database): void {
  db.pragma('journal_mode = WAL')
  // 开启外键约束（better-sqlite3 默认关闭），保证 ON DELETE CASCADE 生效
  db.pragma('foreign_keys = ON')
  // 跨进程写冲突（web 与独立 worker 共用同一 DB）时**等待**而非立刻抛 SQLITE_BUSY。
  // WAL 允许多读单写，但两个进程同时写时，后到的会拿 SQLITE_BUSY；不设 busy_timeout 就是「直接抛」，
  // 会让一次正常的并发写变成 500。5s 足够覆盖一次轻量事务的排队（本批把「跨进程竞争」写进了设计前提）。
  db.pragma('busy_timeout = 5000')

  // ⚠️ 必须在建表之前探测：判据是「credit_ledger 在这次启动前不存在」。
  // 不能用「表里没有行」—— 那样任何把流水清空的情形（手工清理 / 测试造数 / 将来某个 bug）
  // 都会让下次启动按当时的余额重新贴一条期初结存，把已经发生的账目缺口"洗白"成合法历史。
  const ledgerExisted = !!db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'credit_ledger'")
    .get()

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      avatar_url TEXT,
      role TEXT NOT NULL DEFAULT 'user',
      status TEXT NOT NULL DEFAULT 'active',
      must_change_password INTEGER NOT NULL DEFAULT 0,
      disabled_at TEXT,
      credits INTEGER NOT NULL DEFAULT 0,
      invite_code TEXT NOT NULL UNIQUE,
      invited_by TEXT,
      invited_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

    CREATE TABLE IF NOT EXISTS verification_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      purpose TEXT NOT NULL,
      email TEXT NOT NULL,
      code TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_vc_email ON verification_codes(purpose, email);

    CREATE TABLE IF NOT EXISTS topics (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'idle',
      active_message_id TEXT,
      active_prompt TEXT,
      canvas_meta TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_topics_user ON topics(user_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      prompt TEXT NOT NULL,
      final_prompt TEXT NOT NULL,
      size TEXT NOT NULL,
      requested_count INTEGER NOT NULL,
      enhance_prompt INTEGER NOT NULL DEFAULT 0,
      reference_ids TEXT NOT NULL DEFAULT '[]',
      -- 待生成槽位计划（#88）：JSON 数组，第 i 项 ↔ 本轮第 i 张产出。
      -- 挂 message 上而不是新表 —— 骨架只是「这一轮的预占」，随消息同生同灭。
      slot_plan TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'queued',
      worker_id TEXT,
      locked_at TEXT,
      lease_token TEXT,
      lease_expires_at TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_topic ON messages(topic_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);

    CREATE TABLE IF NOT EXISTS canvas_images (
      id TEXT PRIMARY KEY,
      topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message_id TEXT,
      origin TEXT NOT NULL,
      serial INTEGER NOT NULL,
      name TEXT NOT NULL,
      image_key TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      canvas_x REAL NOT NULL DEFAULT 0,
      canvas_y REAL NOT NULL DEFAULT 0,
      canvas_w REAL NOT NULL DEFAULT 0,
      canvas_h REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_canvas_topic ON canvas_images(topic_id, serial);

    CREATE TABLE IF NOT EXISTS cdks (
      code TEXT PRIMARY KEY,
      credits INTEGER NOT NULL,
      redeemed_by TEXT,
      redeemed_at TEXT,
      created_at TEXT NOT NULL,
      revoked_at TEXT
    );

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      package_id TEXT NOT NULL,
      credits INTEGER NOT NULL,
      amount_total INTEGER NOT NULL,
      currency TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      channel TEXT NOT NULL DEFAULT 'mock',
      created_at TEXT NOT NULL,
      paid_at TEXT
    );

    CREATE TABLE IF NOT EXISTS reference_uploads (
      id TEXT PRIMARY KEY,
      topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      image_key TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      resolved_at TEXT,
      resolved_by TEXT
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admin_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      detail TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_actor ON admin_audit(actor_id, id DESC);

    -- 提示词库：源清单（name/url/homepage/sort_index）是**代码里的清单的副本**，
    -- 每次读源前由 seedPromptSources 覆盖；其余列是抓取状态，只由抓取流程写。
    -- 不建 enabled 列：本仓不做源开关，失败源靠 last_error 如实呈现。
    CREATE TABLE IF NOT EXISTS prompt_sources (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      url             TEXT NOT NULL,
      homepage        TEXT NOT NULL DEFAULT '',
      sort_index      INTEGER NOT NULL DEFAULT 0,
      entry_count     INTEGER NOT NULL DEFAULT 0,
      fetched_at      TEXT,
      last_success_at TEXT,
      last_error      TEXT NOT NULL DEFAULT '',
      signature       TEXT NOT NULL DEFAULT ''
    );

    -- 提示词条目：**全局共享的只读内容**（无 user_id，不是用户数据）。
    -- tags / reference_image_urls 存 JSON 数组文本，读侧容错回退 []。
    -- 抓取成功时按源整源原子替换（DELETE + INSERT 同一事务），失败时一行都不碰。
    CREATE TABLE IF NOT EXISTS prompt_entries (
      source_id            TEXT NOT NULL REFERENCES prompt_sources(id) ON DELETE CASCADE,
      id                   TEXT NOT NULL,
      title                TEXT NOT NULL,
      prompt               TEXT NOT NULL,
      description          TEXT NOT NULL DEFAULT '',
      cover_url            TEXT NOT NULL DEFAULT '',
      reference_image_urls TEXT NOT NULL DEFAULT '[]',
      tags                 TEXT NOT NULL DEFAULT '[]',
      author               TEXT NOT NULL DEFAULT '',
      source_url           TEXT NOT NULL DEFAULT '',
      sort_index           INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (source_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_prompt_entries_source ON prompt_entries(source_id, sort_index);
  `)

  // 旧库平滑迁移：messages.reference_ids + verification_codes.attempts
  // （新库 CREATE 已包含，此处 ALTER 失败可忽略）
  try {
    db.exec("ALTER TABLE messages ADD COLUMN reference_ids TEXT NOT NULL DEFAULT '[]'")
  } catch {
    // 列已存在
  }
  // 旧库平滑迁移：messages.slot_plan（#88 骨架槽位计划）
  try {
    db.exec("ALTER TABLE messages ADD COLUMN slot_plan TEXT NOT NULL DEFAULT '[]'")
  } catch {
    // 列已存在
  }
  try {
    db.exec('ALTER TABLE verification_codes ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0')
  } catch {
    // 列已存在
  }

  // 旧库平滑迁移：三级角色与用户状态（Issue #16）
  for (const ddl of [
    "ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'",
    'ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE users ADD COLUMN disabled_at TEXT',
    'ALTER TABLE cdks ADD COLUMN revoked_at TEXT',
    "ALTER TABLE feedback ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'",
    'ALTER TABLE feedback ADD COLUMN resolved_at TEXT',
    'ALTER TABLE feedback ADD COLUMN resolved_by TEXT',
    "ALTER TABLE orders ADD COLUMN channel TEXT NOT NULL DEFAULT 'mock'",
    // 画布升级：图片摆放 + 图片级 LWW 版本（新列名刻意避开 width/height ——
    // 那两列表示原图像素尺寸，不能复用）
    'ALTER TABLE canvas_images ADD COLUMN canvas_x REAL NOT NULL DEFAULT 0',
    'ALTER TABLE canvas_images ADD COLUMN canvas_y REAL NOT NULL DEFAULT 0',
    'ALTER TABLE canvas_images ADD COLUMN canvas_w REAL NOT NULL DEFAULT 0',
    'ALTER TABLE canvas_images ADD COLUMN canvas_h REAL NOT NULL DEFAULT 0',
    "ALTER TABLE canvas_images ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''",
    // 画布元信息（视口/背景）
    "ALTER TABLE topics ADD COLUMN canvas_meta TEXT NOT NULL DEFAULT '{}'",
  ]) {
    try {
      db.exec(ddl)
    } catch {
      // 列已存在：重复启动时的正常路径
    }
  }

  // 额度流水：把「额度变动」变成一等公民，使 SUM(delta) === SUM(users.credits) 可被断言与巡检
  db.exec(`
    CREATE TABLE IF NOT EXISTS credit_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      delta INTEGER NOT NULL,
      source TEXT NOT NULL,
      ref_id TEXT,
      note TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ledger_user ON credit_ledger(user_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_ledger_source ON credit_ledger(source, id DESC);
  `)

  // 仅当这张表是本次新建时才补期初结存（判据见函数顶部）。老库用户的额度是历史累积的、没有对应流水，
  // 补一条 opening_balance 让不变式在升级库上立刻成立；表已存在则一律不动（缺口如实保留，可被巡检发现）。
  if (!ledgerExisted) {
    const holders = db.prepare('SELECT id, credits FROM users WHERE credits <> 0').all() as Array<{ id: string; credits: number }>
    const insert = db.prepare('INSERT INTO credit_ledger (user_id, delta, source, ref_id, note, created_at) VALUES (?, ?, ?, NULL, ?, ?)')
    const t = new Date().toISOString()
    const tx = db.transaction(() => {
      for (const u of holders) insert.run(u.id, u.credits, 'opening_balance', '升级时的期初结存', t)
    })
    tx()
  }
}
