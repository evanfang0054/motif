import type { Database } from 'better-sqlite3'

/** 表结构：用户 / 会话 / 验证码 / 任务 / 消息 / 画布图片 / CDK / 订单 / 反馈 */
export function applySchema(db: Database): void {
  db.pragma('journal_mode = WAL')
  // 开启外键约束（better-sqlite3 默认关闭），保证 ON DELETE CASCADE 生效
  db.pragma('foreign_keys = ON')
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
      created_at TEXT NOT NULL,
      paid_at TEXT
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
  `)

  // 旧库平滑迁移：messages.reference_ids + verification_codes.attempts
  // （新库 CREATE 已包含，此处 ALTER 失败可忽略）
  try {
    db.exec("ALTER TABLE messages ADD COLUMN reference_ids TEXT NOT NULL DEFAULT '[]'")
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
  ]) {
    try {
      db.exec(ddl)
    } catch {
      // 列已存在：重复启动时的正常路径
    }
  }
}
