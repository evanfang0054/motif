import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import {
  newCanvasImageId,
  newCdkCode,
  newMessageId,
  newTopicId,
  newUserId,
  newInviteCode,
  newVerificationCode,
  newSessionToken,
  newOrderId,
  type CanvasImage,
  type CreditPackage,
  type Message,
  type Topic,
  type TopicDetail,
  type User,
  type UserRole,
  type UserStatus,
} from '@motif/core'
import { applySchema } from './schema'

function nowIso(): string {
  return new Date().toISOString()
}

/** reference_ids 列为 JSON 数组字符串；容错解析历史脏数据 */
function safeParseIds(raw: string | null | undefined): string[] {
  try {
    const v = JSON.parse(raw || '[]')
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** 按状态与关键词构造 CDK 查询条件（供 list / count 共用，避免两处口径漂移） */
function cdkWhere(filter: { status?: 'unredeemed' | 'redeemed' | 'revoked'; q?: string }): { where: string; params: string[] } {
  const clauses: string[] = []
  const params: string[] = []
  if (filter.status === 'unredeemed') clauses.push('redeemed_by IS NULL AND revoked_at IS NULL')
  if (filter.status === 'redeemed') clauses.push('redeemed_by IS NOT NULL')
  if (filter.status === 'revoked') clauses.push('revoked_at IS NOT NULL')
  if (filter.q && filter.q.trim()) {
    clauses.push('code LIKE ?')
    params.push(`%${filter.q.trim().toUpperCase()}%`)
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params }
}

/** 按用户/状态/时间范围构造订单查询条件（供 list / count 共用，避免两处口径漂移） */
function orderWhere(filter: { userId?: string; status?: string; from?: string; to?: string }): { where: string; params: string[] } {
  const clauses: string[] = []
  const params: string[] = []
  if (filter.userId) {
    clauses.push('user_id = ?')
    params.push(filter.userId)
  }
  if (filter.status) {
    clauses.push('status = ?')
    params.push(filter.status)
  }
  if (filter.from) {
    clauses.push('created_at >= ?')
    params.push(filter.from)
  }
  if (filter.to) {
    clauses.push('created_at <= ?')
    params.push(filter.to)
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params }
}

interface UserRow {
  id: string
  email: string
  password_hash: string
  name: string
  avatar_url: string | null
  role: string
  status: string
  must_change_password: number
  disabled_at: string | null
  credits: number
  invite_code: string
  invited_by: string | null
  invited_count: number
  created_at: string
  updated_at: string
}

interface AuditRow {
  id: number
  actor_id: string
  action: string
  target_type: string | null
  target_id: string | null
  detail: string | null
  created_at: string
}

interface TopicRow {
  id: string
  user_id: string
  title: string
  status: string
  active_message_id: string | null
  active_prompt: string | null
  created_at: string
  updated_at: string
}

interface OrderRow {
  id: string
  user_id: string
  package_id: string
  credits: number
  amount_total: number
  currency: string
  status: string
  created_at: string
  paid_at: string | null
}

interface MessageRow {
  id: string
  topic_id: string
  user_id: string
  prompt: string
  final_prompt: string
  size: string
  requested_count: number
  enhance_prompt: number
  reference_ids: string
  status: string
  worker_id: string | null
  locked_at: string | null
  lease_token: string | null
  lease_expires_at: string | null
  attempts: number
  error: string | null
  created_at: string
}

interface CanvasImageRow {
  id: string
  topic_id: string
  user_id: string
  message_id: string | null
  origin: string
  serial: number
  name: string
  image_key: string
  mime_type: string
  bytes: number
  width: number
  height: number
  created_at: string
}

function rowToUser(r: UserRow): User {
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    avatarUrl: r.avatar_url,
    role: r.role as User['role'],
    status: (r.status ?? 'active') as UserStatus,
    mustChangePassword: !!r.must_change_password,
    credits: r.credits,
    inviteCode: r.invite_code,
    invitedCount: r.invited_count,
  }
}
function rowToTopic(r: TopicRow): Topic {
  return {
    id: r.id,
    userId: r.user_id,
    title: r.title,
    status: r.status as Topic['status'],
    activeMessageId: r.active_message_id,
    activePrompt: r.active_prompt,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}
function rowToMessage(r: MessageRow): Message {
  return {
    id: r.id,
    topicId: r.topic_id,
    userId: r.user_id,
    prompt: r.prompt,
    finalPrompt: r.final_prompt,
    size: r.size,
    requestedCount: r.requested_count,
    enhancePrompt: !!r.enhance_prompt,
    referenceIds: safeParseIds(r.reference_ids),
    status: r.status as Message['status'],
    workerId: r.worker_id,
    lockedAt: r.locked_at,
    leaseToken: r.lease_token,
    leaseExpiresAt: r.lease_expires_at,
    attempts: r.attempts,
    error: r.error,
    createdAt: r.created_at,
  }
}
function rowToCanvasImage(r: CanvasImageRow): CanvasImage {
  return {
    id: r.id,
    topicId: r.topic_id,
    userId: r.user_id,
    origin: r.origin as CanvasImage['origin'],
    serial: r.serial,
    name: r.name,
    src: `/api/canvas-images/${r.id}`,
    imageKey: r.image_key,
    mimeType: r.mime_type,
    bytes: r.bytes,
    width: r.width,
    height: r.height,
    messageId: r.message_id,
    createdAt: r.created_at,
  }
}

export interface CreateUserInput {
  email: string
  passwordHash: string
  name: string
  invitedBy?: string | null
  credits?: number
  /** 缺省为普通用户 */
  role?: UserRole
  /** 由引导或管理员重置产生时置真 */
  mustChangePassword?: boolean
}

/** SQLite 存储层：所有持久化读写集中在这里 */
export class MotifStore {
  readonly db: Database.Database

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true })
    this.db = new Database(file)
    applySchema(this.db)
  }

  close(): void {
    this.db.close()
  }

  // ---------- users ----------

  createUser(input: CreateUserInput): User {
    const id = newUserId()
    const t = nowIso()
    const inviteCode = newInviteCode()
    this.db
      .prepare(
        `INSERT INTO users (id, email, password_hash, name, avatar_url, role, status, must_change_password, disabled_at, credits, invite_code, invited_by, invited_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?, 'active', ?, NULL, ?, ?, ?, 0, ?, ?)`
      )
      .run(
        id,
        input.email.toLowerCase(),
        input.passwordHash,
        input.name,
        input.role ?? 'user',
        input.mustChangePassword ? 1 : 0,
        input.credits ?? 0,
        inviteCode,
        input.invitedBy ?? null,
        t,
        t
      )
    return this.getUserById(id)!
  }

  getUserByEmail(email: string): User | null {
    const row = this.db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase()) as UserRow | undefined
    return row ? rowToUser(row) : null
  }

  getUserById(id: string): User | null {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined
    return row ? rowToUser(row) : null
  }

  getPasswordHash(userId: string): string | null {
    const row = this.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as { password_hash: string } | undefined
    return row ? row.password_hash : null
  }

  updateUserPassword(userId: string, passwordHash: string): void {
    this.db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(passwordHash, nowIso(), userId)
  }

  updateUserProfile(userId: string, patch: { name?: string; avatarUrl?: string | null }): void {
    if (patch.name !== undefined) this.db.prepare('UPDATE users SET name = ?, updated_at = ? WHERE id = ?').run(patch.name, nowIso(), userId)
    if (patch.avatarUrl !== undefined) this.db.prepare('UPDATE users SET avatar_url = ?, updated_at = ? WHERE id = ?').run(patch.avatarUrl, nowIso(), userId)
  }

  getUserByInviteCode(code: string): User | null {
    const row = this.db.prepare('SELECT * FROM users WHERE invite_code = ?').get(code) as UserRow | undefined
    return row ? rowToUser(row) : null
  }

  /** 原子扣减额度；余额不足返回 null */
  deductCredits(userId: string, amount: number): User | null {
    const tx = this.db.transaction((): User | null => {
      const row = this.db.prepare('SELECT credits FROM users WHERE id = ?').get(userId) as { credits: number } | undefined
      if (!row || row.credits < amount) return null
      this.db.prepare('UPDATE users SET credits = credits - ?, updated_at = ? WHERE id = ?').run(amount, nowIso(), userId)
      return this.getUserById(userId)
    })
    return tx()
  }

  addCredits(userId: string, amount: number): User {
    this.db.prepare('UPDATE users SET credits = credits + ?, updated_at = ? WHERE id = ?').run(amount, nowIso(), userId)
    return this.getUserById(userId)!
  }

  /** 记录邀请成功；返回受赠额度（受上限约束） */
  recordInvite(inviterId: string, reward: number): void {
    this.db.prepare('UPDATE users SET invited_count = invited_count + 1, updated_at = ? WHERE id = ?').run(nowIso(), inviterId)
    if (reward > 0) this.addCredits(inviterId, reward)
  }

  countUsersByRole(role: UserRole): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM users WHERE role = ?').get(role) as { c: number }
    return row.c
  }

  /**
   * 更新角色。**不加保护** —— 「管理员不可操作超级管理员」「最后一个超级管理员不可降级」
   * 是服务层契约（apps/web/src/server/admin.ts 的 assertCanModifyRole），调用方必须先过断言。
   */
  updateUserRole(userId: string, role: UserRole): void {
    this.db.prepare('UPDATE users SET role = ?, updated_at = ? WHERE id = ?').run(role, nowIso(), userId)
  }

  /** 禁用时记录 disabled_at；启用时清空。保护规则同 updateUserRole。 */
  setUserStatus(userId: string, status: UserStatus): void {
    this.db
      .prepare('UPDATE users SET status = ?, disabled_at = ?, updated_at = ? WHERE id = ?')
      .run(status, status === 'disabled' ? nowIso() : null, nowIso(), userId)
  }

  setMustChangePassword(userId: string, value: boolean): void {
    this.db.prepare('UPDATE users SET must_change_password = ?, updated_at = ? WHERE id = ?').run(value ? 1 : 0, nowIso(), userId)
  }

  // ---------- sessions ----------

  /** 会话 token 入库前做 sha256：DB 备份/泄漏不等于可用会话 */
  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex')
  }

  createSession(userId: string, ttlMs: number): string {
    const token = newSessionToken()
    const t = Date.now()
    this.db
      .prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(this.hashToken(token), userId, new Date(t).toISOString(), new Date(t + ttlMs).toISOString())
    return token
  }

  getUserBySession(token: string): User | null {
    const row = this.db
      .prepare('SELECT user_id FROM sessions WHERE token = ? AND expires_at > ?')
      .get(this.hashToken(token), nowIso()) as { user_id: string } | undefined
    if (!row) return null
    return this.getUserById(row.user_id)
  }

  deleteSession(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token = ?').run(this.hashToken(token))
  }

  /** 吊销用户全部会话（可选保留一个，如改密时的当前会话） */
  revokeUserSessions(userId: string, exceptToken?: string): void {
    if (exceptToken) {
      this.db
        .prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?')
        .run(userId, this.hashToken(exceptToken))
    } else {
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId)
    }
  }

  // ---------- verification codes ----------

  createVerificationCode(purpose: 'register' | 'password-reset', email: string, ttlMs: number): string {
    // 同邮箱旧码作废
    this.db.prepare('UPDATE verification_codes SET used = 1 WHERE purpose = ? AND email = ? AND used = 0').run(purpose, email.toLowerCase())
    const code = newVerificationCode()
    const t = Date.now()
    this.db
      .prepare('INSERT INTO verification_codes (purpose, email, code, used, created_at, expires_at) VALUES (?, ?, ?, 0, ?, ?)')
      .run(purpose, email.toLowerCase(), code, new Date(t).toISOString(), new Date(t + ttlMs).toISOString())
    return code
  }

  /** 连续错 5 次当前码即作废（防 6 位码暴力穷举） */
  static readonly MAX_CODE_ATTEMPTS = 5

  consumeVerificationCode(purpose: 'register' | 'password-reset', email: string, code: string): boolean {
    const emailLc = email.toLowerCase()
    const now = nowIso()
    const active = this.db
      .prepare(
        `SELECT id, code, attempts FROM verification_codes
         WHERE purpose = ? AND email = ? AND used = 0 AND expires_at > ?
         ORDER BY id DESC LIMIT 1`
      )
      .get(purpose, emailLc, now) as { id: number; code: string; attempts: number } | undefined
    if (!active) return false

    if (active.code === code) {
      this.db.prepare('UPDATE verification_codes SET used = 1 WHERE id = ?').run(active.id)
      return true
    }
    // 错误尝试：计数 +1，达到上限直接作废当前码
    const attempts = active.attempts + 1
    const used = attempts >= MotifStore.MAX_CODE_ATTEMPTS ? 1 : 0
    this.db.prepare('UPDATE verification_codes SET attempts = ?, used = ? WHERE id = ?').run(attempts, used, active.id)
    return false
  }

  // ---------- topics ----------

  createTopic(userId: string, title: string): Topic {
    const id = newTopicId()
    const t = nowIso()
    this.db
      .prepare(
        `INSERT INTO topics (id, user_id, title, status, active_message_id, active_prompt, created_at, updated_at)
         VALUES (?, ?, ?, 'idle', NULL, NULL, ?, ?)`
      )
      .run(id, userId, title, t, t)
    return this.getTopic(id)!
  }

  getTopic(id: string): Topic | null {
    const row = this.db.prepare('SELECT * FROM topics WHERE id = ?').get(id) as TopicRow | undefined
    return row ? rowToTopic(row) : null
  }

  listTopics(userId: string): Topic[] {
    const rows = this.db.prepare('SELECT * FROM topics WHERE user_id = ? ORDER BY updated_at DESC').all(userId) as TopicRow[]
    return rows.map(rowToTopic)
  }

  /** 「新任务」复用：当前用户最近更新的 idle 且 0 张画布图的会话（不存在则 null） */
  findReusableTopic(userId: string): Topic | null {
    const row = this.db
      .prepare(
        `SELECT t.* FROM topics t
         WHERE t.user_id = ? AND t.status = 'idle'
           AND NOT EXISTS (SELECT 1 FROM canvas_images ci WHERE ci.topic_id = t.id)
         ORDER BY t.updated_at DESC, t.id DESC LIMIT 1`
      )
      .get(userId) as TopicRow | undefined
    return row ? rowToTopic(row) : null
  }

  renameTopic(id: string, title: string): Topic | null {
    this.db.prepare('UPDATE topics SET title = ?, updated_at = ? WHERE id = ?').run(title, nowIso(), id)
    return this.getTopic(id)
  }

  setTopicActive(id: string, messageId: string | null, prompt: string | null, status: string): void {
    this.db
      .prepare('UPDATE topics SET active_message_id = ?, active_prompt = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(messageId, prompt, status, nowIso(), id)
  }

  touchTopic(id: string): void {
    this.db.prepare('UPDATE topics SET updated_at = ? WHERE id = ?').run(nowIso(), id)
  }

  /** 删除任务（FK 级联清理行），返回需清理的磁盘文件 key 列表 */
  deleteTopic(id: string): string[] {
    const keys = (
      this.db.prepare('SELECT image_key FROM canvas_images WHERE topic_id = ?').all(id) as { image_key: string }[]
    ).map((r) => r.image_key)
    this.db.prepare('DELETE FROM topics WHERE id = ?').run(id)
    return keys
  }

  getTopicDetail(id: string): TopicDetail | null {
    const topic = this.getTopic(id)
    if (!topic) return null
    const messages = (this.db.prepare('SELECT * FROM messages WHERE topic_id = ? ORDER BY created_at, id').all(id) as MessageRow[]).map(rowToMessage)
    const canvasImages = (this.db.prepare('SELECT * FROM canvas_images WHERE topic_id = ? ORDER BY serial').all(id) as CanvasImageRow[]).map(rowToCanvasImage)
    const messageReferences = canvasImages.filter((i) => i.origin === 'uploaded').map((i) => i.serial)
    return { topic, messages, canvasImages, messageReferences }
  }

  // ---------- messages ----------

  createMessage(input: {
    topicId: string
    userId: string
    prompt: string
    finalPrompt: string
    size: string
    requestedCount: number
    enhancePrompt: boolean
    referenceIds?: string[]
  }): Message {
    const id = newMessageId()
    const t = nowIso()
    this.db
      .prepare(
        `INSERT INTO messages (id, topic_id, user_id, prompt, final_prompt, size, requested_count, enhance_prompt, reference_ids, status, attempts, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?)`
      )
      .run(id, input.topicId, input.userId, input.prompt, input.finalPrompt, input.size, input.requestedCount, input.enhancePrompt ? 1 : 0, JSON.stringify(input.referenceIds ?? []), t)
    return this.getMessage(id)!
  }

  getMessage(id: string): Message | null {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined
    return row ? rowToMessage(row) : null
  }

  listMessages(topicId: string): Message[] {
    const rows = this.db.prepare('SELECT * FROM messages WHERE topic_id = ? ORDER BY created_at, id').all(topicId) as MessageRow[]
    return rows.map(rowToMessage)
  }

  /** 队列租约：worker 认领一条排队中的消息 */
  leaseNextMessage(workerId: string, leaseMs: number): Message | null {
    const tx = this.db.transaction((): Message | null => {
      const row = this.db
        .prepare(`SELECT * FROM messages WHERE status = 'queued' ORDER BY created_at LIMIT 1`)
        .get() as MessageRow | undefined
      if (!row) return null
      const t = Date.now()
      this.db
        .prepare(`UPDATE messages SET status = 'running', worker_id = ?, locked_at = ?, lease_token = ?, lease_expires_at = ?, attempts = attempts + 1 WHERE id = ?`)
        .run(workerId, new Date(t).toISOString(), workerId, new Date(t + leaseMs).toISOString(), row.id)
      return this.getMessage(row.id)
    })
    return tx()
  }

  setMessageStatus(id: string, status: string, error?: string | null): void {
    this.db
      .prepare('UPDATE messages SET status = ?, error = ?, worker_id = NULL, lease_token = NULL, lease_expires_at = NULL WHERE id = ?')
      .run(status, error ?? null, id)
  }

  /**
   * 归还过期租约的消息回队列（崩溃恢复）。
   * skipIds：本进程 worker 正在执行的消息——租约过期也不回收，避免「执行中→被重排→取消全额退」的双退额窗口。
   */
  requeueExpiredLeases(skipIds: string[] = []): void {
    const placeholders = skipIds.map(() => '?').join(',')
    const skipClause = skipIds.length ? ` AND id NOT IN (${placeholders})` : ''
    this.db
      .prepare(
        `UPDATE messages SET status = 'queued', worker_id = NULL, lease_token = NULL, lease_expires_at = NULL
         WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?${skipClause}`
      )
      .run(nowIso(), ...skipIds)
  }

  /**
   * 条件取消「尚未被认领」的消息（事务）：仅当仍为 queued 时全额退额并置 canceled。
   * 与 worker 的租约认领天然互斥（认领会把状态改成 running），杜绝双退。
   * 返回 refund=null 表示消息不在排队态（已开跑，走 canceling 流程）。
   */
  cancelQueuedMessage(id: string, userId: string): { found: boolean; canceled: boolean; refund: number } {
    const tx = this.db.transaction((): { found: boolean; canceled: boolean; refund: number } => {
      const row = this.db
        .prepare(`SELECT id, user_id, topic_id, requested_count, status FROM messages WHERE id = ?`)
        .get(id) as { id: string; user_id: string; topic_id: string; requested_count: number; status: string } | undefined
      if (!row || row.user_id !== userId) return { found: false, canceled: false, refund: 0 }
      if (row.status !== 'queued') return { found: true, canceled: false, refund: 0 }
      const res = this.db
        .prepare(`UPDATE messages SET status = 'canceled', worker_id = NULL, lease_token = NULL, lease_expires_at = NULL WHERE id = ? AND status = 'queued'`)
        .run(id)
      if (res.changes === 0) return { found: true, canceled: false, refund: 0 }
      this.db
        .prepare(`UPDATE users SET credits = credits + ?, updated_at = ? WHERE id = ?`)
        .run(row.requested_count, nowIso(), userId)
      this.db
        .prepare(`UPDATE topics SET active_message_id = NULL, active_prompt = NULL, status = 'idle', updated_at = ? WHERE id = ?`)
        .run(nowIso(), row.topic_id)
      return { found: true, canceled: true, refund: row.requested_count }
    })
    return tx()
  }

  // ---------- canvas images ----------

  nextSerial(topicId: string): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(serial), 0) AS m FROM canvas_images WHERE topic_id = ?').get(topicId) as { m: number }
    return row.m + 1
  }

  insertCanvasImage(input: {
    topicId: string
    userId: string
    messageId: string | null
    origin: 'generated' | 'uploaded'
    name: string
    imageKey: string
    mimeType: string
    bytes: number
    width: number
    height: number
  }): CanvasImage {
    const id = newCanvasImageId()
    const serial = this.nextSerial(input.topicId)
    this.db
      .prepare(
        `INSERT INTO canvas_images (id, topic_id, user_id, message_id, origin, serial, name, image_key, mime_type, bytes, width, height, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, input.topicId, input.userId, input.messageId, input.origin, serial, input.name, input.imageKey, input.mimeType, input.bytes, input.width, input.height, nowIso())
    return this.getCanvasImage(id)!
  }

  getCanvasImage(id: string): CanvasImage | null {
    const row = this.db.prepare('SELECT * FROM canvas_images WHERE id = ?').get(id) as CanvasImageRow | undefined
    return row ? rowToCanvasImage(row) : null
  }

  listCanvasImages(topicId: string): CanvasImage[] {
    const rows = this.db.prepare('SELECT * FROM canvas_images WHERE topic_id = ? ORDER BY serial').all(topicId) as CanvasImageRow[]
    return rows.map(rowToCanvasImage)
  }

  countGeneratedInMessage(messageId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM canvas_images WHERE message_id = ? AND origin = 'generated'`)
      .get(messageId) as { c: number }
    return row.c
  }

  deleteCanvasImage(id: string): void {
    this.db.prepare('DELETE FROM canvas_images WHERE id = ?').run(id)
  }

  /** 批量删除画布图片行（归属校验由调用方完成）；空数组直接返回 */
  deleteCanvasImages(ids: string[]): void {
    if (ids.length === 0) return
    const placeholders = ids.map(() => '?').join(',')
    this.db.prepare(`DELETE FROM canvas_images WHERE id IN (${placeholders})`).run(...ids)
  }

  // ---------- cdks ----------

  createCdk(code: string, credits: number): void {
    this.db.prepare('INSERT INTO cdks (code, credits, created_at) VALUES (?, ?, ?)').run(code.toUpperCase(), credits, nowIso())
  }

  /**
   * 批量生成 CDK：单事务插入，码冲突时换码重试。
   * 任一步失败整批回滚，不留部分写入（调用方据此可安全重试）。
   */
  createCdkBatch(input: {
    count: number
    credits: number
    prefix?: string
    maxRetries?: number
    /** 仅测试注入用；生产走 newCdkCode */
    codeFactory?: () => string
  }): string[] {
    const count = input.count
    if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('批量生成数量需在 1–100 之间。')
    if (!Number.isInteger(input.credits) || input.credits < 1) throw new Error('面额需为正整数。')
    const maxRetries = input.maxRetries ?? 5
    const factory = input.codeFactory ?? (() => newCdkCode(input.prefix))

    const tx = this.db.transaction((): string[] => {
      const created: string[] = []
      const insert = this.db.prepare('INSERT INTO cdks (code, credits, created_at) VALUES (?, ?, ?)')
      for (let i = 0; i < count; i++) {
        let placed = false
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          const code = factory().toUpperCase()
          // 批内重复与主键冲突**都消耗 attempt 预算**，语义一致：这一次没放成
          if (created.includes(code)) continue
          try {
            insert.run(code, input.credits, nowIso())
            created.push(code)
            placed = true
            break
          } catch {
            // 主键冲突：换码重试
          }
        }
        if (!placed) throw new Error('CDK 码生成冲突次数过多，请重试。')
      }
      return created
    })
    return tx()
  }

  listCdks(filter: { status?: 'unredeemed' | 'redeemed' | 'revoked'; q?: string; limit?: number; offset?: number }): Array<{
    code: string
    credits: number
    redeemedBy: string | null
    redeemedAt: string | null
    revokedAt: string | null
    createdAt: string
  }> {
    const { where, params } = cdkWhere(filter)
    const limit = filter.limit ?? 50
    const offset = filter.offset ?? 0
    const rows = this.db
      .prepare(`SELECT code, credits, redeemed_by, redeemed_at, revoked_at, created_at FROM cdks ${where} ORDER BY created_at DESC, code DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as Array<{ code: string; credits: number; redeemed_by: string | null; redeemed_at: string | null; revoked_at: string | null; created_at: string }>
    return rows.map((r) => ({
      code: r.code,
      credits: r.credits,
      redeemedBy: r.redeemed_by,
      redeemedAt: r.redeemed_at,
      revokedAt: r.revoked_at,
      createdAt: r.created_at,
    }))
  }

  countCdks(filter: { status?: 'unredeemed' | 'redeemed' | 'revoked'; q?: string }): number {
    const { where, params } = cdkWhere(filter)
    const row = this.db.prepare(`SELECT COUNT(*) AS c FROM cdks ${where}`).get(...params) as { c: number }
    return row.c
  }

  /** 精确取一张码。作废/详情的前置检查必须用它 —— 不能用 `listCdks({q})`（LIKE + LIMIT 1 会漏判） */
  getCdk(code: string): { code: string; credits: number; redeemedBy: string | null; redeemedAt: string | null; revokedAt: string | null; createdAt: string } | null {
    const r = this.db
      .prepare('SELECT code, credits, redeemed_by, redeemed_at, revoked_at, created_at FROM cdks WHERE code = ?')
      .get(code.toUpperCase()) as { code: string; credits: number; redeemed_by: string | null; redeemed_at: string | null; revoked_at: string | null; created_at: string } | undefined
    if (!r) return null
    return { code: r.code, credits: r.credits, redeemedBy: r.redeemed_by, redeemedAt: r.redeemed_at, revokedAt: r.revoked_at, createdAt: r.created_at }
  }

  /**
   * 作废一张未兑换的码。已兑换或已作废返回 false（幂等拒绝，不覆盖 revoked_at）。
   * 条件 UPDATE 保证与并发兑换互斥：只有仍是「未兑换未作废」时才写入。
   */
  revokeCdk(code: string): boolean {
    const res = this.db
      .prepare('UPDATE cdks SET revoked_at = ? WHERE code = ? AND redeemed_by IS NULL AND revoked_at IS NULL')
      .run(nowIso(), code.toUpperCase())
    return res.changes === 1
  }

  redeemCdk(code: string, userId: string): number | null {
    const tx = this.db.transaction((): number | null => {
      const row = this.db
        .prepare('SELECT credits, redeemed_by, revoked_at FROM cdks WHERE code = ?')
        .get(code.toUpperCase()) as { credits: number; redeemed_by: string | null; revoked_at: string | null } | undefined
      // 已作废的码不可兑换：修复前只判断 redeemed_by、忽略 revoked_at，导致作废形同虚设
      if (!row || row.redeemed_by || row.revoked_at) return null
      // 条件 UPDATE：并发下只有一个请求能把 redeemed_by 从 NULL 写成自己
      const res = this.db
        .prepare('UPDATE cdks SET redeemed_by = ?, redeemed_at = ? WHERE code = ? AND redeemed_by IS NULL AND revoked_at IS NULL')
        .run(userId, nowIso(), code.toUpperCase())
      if (res.changes !== 1) return null
      return row.credits
    })
    return tx()
  }

  // ---------- orders ----------

  createOrder(userId: string, pkg: CreditPackage): string {
    const id = newOrderId()
    this.db
      .prepare('INSERT INTO orders (id, user_id, package_id, credits, amount_total, currency, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, userId, pkg.id, pkg.credits, pkg.amountTotal, pkg.currency, 'pending', nowIso())
    return id
  }

  payOrder(orderId: string, userId: string): number | null {
    const tx = this.db.transaction((): number | null => {
      const row = this.db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(orderId, userId) as { credits: number; status: string } | undefined
      if (!row || row.status === 'paid') return null
      this.db.prepare('UPDATE orders SET status = ?, paid_at = ? WHERE id = ?').run('paid', nowIso(), orderId)
      return row.credits
    })
    return tx()
  }

  listOrders(filter: { userId?: string; status?: string; from?: string; to?: string; limit?: number; offset?: number }): Array<{
    id: string
    userId: string
    packageId: string
    credits: number
    amountTotal: number
    currency: string
    status: string
    createdAt: string
    paidAt: string | null
  }> {
    const { where, params } = orderWhere(filter)
    const limit = filter.limit ?? 50
    const offset = filter.offset ?? 0
    const rows = this.db
      .prepare(`SELECT * FROM orders ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as OrderRow[]
    return rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      packageId: r.package_id,
      credits: r.credits,
      amountTotal: r.amount_total,
      currency: r.currency,
      status: r.status,
      createdAt: r.created_at,
      paidAt: r.paid_at,
    }))
  }

  countOrders(filter: { userId?: string; status?: string; from?: string; to?: string }): number {
    const { where, params } = orderWhere(filter)
    const row = this.db.prepare(`SELECT COUNT(*) AS c FROM orders ${where}`).get(...params) as { c: number }
    return row.c
  }

  // ---------- feedback ----------

  insertFeedback(userId: string, content: string): void {
    this.db.prepare('INSERT INTO feedback (user_id, content, created_at) VALUES (?, ?, ?)').run(userId, content, nowIso())
  }

  // ---------- admin audit ----------

  insertAudit(input: {
    actorId: string
    action: string
    targetType?: string | null
    targetId?: string | null
    detail?: string | null
  }): void {
    this.db
      .prepare('INSERT INTO admin_audit (actor_id, action, target_type, target_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(input.actorId, input.action, input.targetType ?? null, input.targetId ?? null, input.detail ?? null, nowIso())
  }

  /** 审计流水（可按操作者过滤，倒序，默认上限 100 条） */
  listAudit(filter: { actorId?: string; limit?: number } = {}): Array<{
    id: number
    actorId: string
    action: string
    targetType: string | null
    targetId: string | null
    detail: string | null
    createdAt: string
  }> {
    const limit = filter.limit ?? 100
    const rows = filter.actorId
      ? (this.db.prepare('SELECT * FROM admin_audit WHERE actor_id = ? ORDER BY id DESC LIMIT ?').all(filter.actorId, limit) as AuditRow[])
      : (this.db.prepare('SELECT * FROM admin_audit ORDER BY id DESC LIMIT ?').all(limit) as AuditRow[])
    return rows.map((r) => ({
      id: r.id,
      actorId: r.actor_id,
      action: r.action,
      targetType: r.target_type,
      targetId: r.target_id,
      detail: r.detail,
      createdAt: r.created_at,
    }))
  }
}

/** 图片二进制存储：dataDir/storage/<imageKey>，imageKey 含用户/任务隔离路径 */
export function storagePathFor(dataDir: string, imageKey: string): string {
  return join(dataDir, 'storage', imageKey)
}

export function buildImageKey(userId: string, topicId: string, messageId: string | null, filename: string): string {
  const kind = messageId ? `messages/${messageId}/generated` : 'references'
  return `users/${userId}/topics/${topicId}/${kind}/${filename}`
}
