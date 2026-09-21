import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import {
  allocateSlots,
  displaySize,
  parseCanvasMeta,
  placementRect,
  rectToPlacement,
  viewportOrigin,
  newCanvasImageId,
  newCdkCode,
  newMessageId,
  newReferenceUploadId,
  newTopicId,
  newUserId,
  newInviteCode,
  newVerificationCode,
  newSessionToken,
  newOrderId,
  type CanvasImage,
  type CanvasImagePlacement,
  type CanvasMeta,
  type CreditPackage,
  type CreditSource,
  type Message,
  type MessageStatus,
  type StagedReference,
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

/** 按操作者/动作/时间构造审计查询条件（供 list / count 共用）。action 用**精确匹配** —— 前缀匹配会让 credit.adjust 与 credit.adjust.rollback 互相污染 */
function auditWhere(filter: { actorId?: string; action?: string; from?: string; to?: string }): { where: string; params: string[] } {
  const clauses: string[] = []
  const params: string[] = []
  if (filter.actorId) {
    clauses.push('actor_id = ?')
    params.push(filter.actorId)
  }
  if (filter.action) {
    clauses.push('action = ?')
    params.push(filter.action)
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

/** 审计流水行（管理端分页视图） */
export interface AuditLogRow {
  id: number
  actorId: string
  action: string
  targetType: string | null
  targetId: string | null
  detail: string | null
  createdAt: string
}

/**
 * 一条配置项。value 一律以字符串存储 —— 存储层**不解释语义**，
 * 类型化解析（布尔 / 枚举 / URL / 密钥）集中在 apps/web/src/server/settings.ts。
 */
export interface SettingRow {
  key: string
  value: string
  updatedAt: string
}

/** 按状态/用户/时间构造生成轮次查询条件（供 list / count 共用） */
function messageWhere(filter: { status?: MessageStatus; userId?: string; from?: string; to?: string }): { where: string; params: string[] } {
  const clauses: string[] = []
  const params: string[] = []
  if (filter.status) {
    clauses.push('m.status = ?')
    params.push(filter.status)
  }
  if (filter.userId) {
    clauses.push('m.user_id = ?')
    params.push(filter.userId)
  }
  if (filter.from) {
    clauses.push('m.created_at >= ?')
    params.push(filter.from)
  }
  if (filter.to) {
    clauses.push('m.created_at <= ?')
    params.push(filter.to)
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params }
}

/** 生成日志行（管理端跨用户视图） */
export interface AdminLogRow {
  id: string
  topicId: string
  userId: string
  prompt: string
  finalPrompt: string
  size: string
  requestedCount: number
  status: MessageStatus
  attempts: number
  error: string | null
  generatedCount: number
  createdAt: string
}

/** 按状态构造反馈查询条件（供 list / count 共用，避免两处口径漂移） */
function feedbackWhere(filter: { status?: 'pending' | 'resolved' }): { where: string; params: string[] } {
  if (!filter.status) return { where: '', params: [] }
  return { where: 'WHERE status = ?', params: [filter.status] }
}

interface FeedbackDbRow {
  id: number
  user_id: string
  content: string
  status: string
  resolved_at: string | null
  resolved_by: string | null
  created_at: string
}

/** 反馈列表行（管理端视图） */
export interface FeedbackRow {
  id: number
  userId: string
  content: string
  status: string
  resolvedAt: string | null
  resolvedBy: string | null
  createdAt: string
}

/** 按关键词/角色/状态构造用户查询条件（供 list / count 共用，避免两处口径漂移） */
function userWhere(filter: { q?: string; role?: UserRole; status?: UserStatus }): { where: string; params: string[] } {
  const clauses: string[] = []
  const params: string[] = []
  if (filter.q && filter.q.trim()) {
    // 邮箱与昵称都搜。邮箱统一小写存储，故用小写的 like 参数即可覆盖大小写；
    // 昵称保持大小写敏感（不为此引入 LOWER() 全表扫描），中文昵称不受影响
    clauses.push('(email LIKE ? OR name LIKE ?)')
    const like = `%${filter.q.trim().toLowerCase()}%`
    params.push(like, like)
  }
  if (filter.role) {
    clauses.push('role = ?')
    params.push(filter.role)
  }
  if (filter.status) {
    clauses.push('status = ?')
    params.push(filter.status)
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params }
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

/** 额度流水的写入参数。`source` 必填 —— 没有来源的额度变动等于不可对账 */
export interface LedgerEntry {
  source: CreditSource
  refId?: string | null
  note?: string | null
}

export interface LedgerRow {
  id: number
  userId: string
  delta: number
  source: CreditSource
  refId: string | null
  note: string | null
  createdAt: string
}

interface LedgerDbRow {
  id: number
  user_id: string
  delta: number
  source: string
  ref_id: string | null
  note: string | null
  created_at: string
}

/**
 * 概览看板的六组指标。
 *
 * 额度口径：`granted` **不含**退款（否则会与 `netSpent` 的减项重复计数）、不含期初结存（那是迁移前的
 * 历史存量）、不含管理调整（它有自己的正/负一对数字）。它们之间满足闭合恒等式：
 *   `balance === granted + openingBalance + adjustedIn + refunded - adjustedOut - generatedCharged`
 * 而 `ledgerSum === balance` 由全局不变式保证 —— 把两者都返回，是为了让差值成为可巡检的观测量。
 */
export interface AdminOverview {
  users: { total: number; newLast7d: number }
  credits: {
    balance: number
    ledgerSum: number
    granted: number
    openingBalance: number
    adjustedIn: number
    adjustedOut: number
    generatedCharged: number
    refunded: number
    netSpent: number
    bySource: Array<{ source: CreditSource; net: number; inflow: number; outflow: number }>
  }
  generations: { total: number; terminal: number; succeeded: number; successRate: number; topErrors: Array<{ error: string; count: number }> }
  orders: { pending: number; paid: number; amountTotal: number }
  cdks: { unredeemed: number; redeemed: number; revoked: number }
  feedback: { pending: number }
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
  canvas_x: number
  canvas_y: number
  canvas_w: number
  canvas_h: number
  updated_at: string
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
    canvasX: r.canvas_x,
    canvasY: r.canvas_y,
    canvasWidth: r.canvas_w,
    canvasHeight: r.canvas_h,
    updatedAt: r.updated_at,
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

/** 提示词源的一行：清单列来自代码（`lib/prompt-sources.ts`），状态列来自抓取 */
export interface PromptSourceRow {
  id: string
  name: string
  url: string
  homepage: string
  sortIndex: number
  entryCount: number
  /** 最近一次抓取**尝试**（无论成败）；null = 从未抓过 */
  fetchedAt: string | null
  /** 最近一次成功；失败时不更新 */
  lastSuccessAt: string | null
  /** 空串 = 上次抓取成功 */
  lastError: string
  /** 最近一次抓取**尝试**时的源定义签名；变了即视为陈旧 */
  signature: string
}

/** 一条待写入的提示词条目（抓取解析结果） */
export interface PromptEntryInput {
  id: string
  title: string
  prompt: string
  description: string
  coverUrl: string
  referenceImageUrls: string[]
  tags: string[]
  author: string
  sourceUrl: string
}

/** 一条读出的提示词条目（附带来源信息，供筛选与展示） */
export interface PromptEntryRow extends PromptEntryInput {
  sourceId: string
  sourceName: string
  sortIndex: number
}

/** 提示词源清单（代码是真相，DB 只存副本与抓取状态） */
export interface PromptSourceDefInput {
  id: string
  name: string
  url: string
  homepage: string
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
    const initialCredits = input.credits ?? 0
    const tx = this.db.transaction((): void => {
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
          initialCredits,
          inviteCode,
          input.invitedBy ?? null,
          t,
          t
        )
      // 建档时就带额度（引导、测试造数）→ 记一条 opening_balance，使不变式从第一行起就成立
      if (initialCredits > 0) this.insertLedger(id, initialCredits, { source: 'opening_balance', note: '建档初始额度' })
    })
    tx()
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

  /**
   * 原子扣减额度；余额不足返回 null（不做部分扣减）。
   * 余额更新与流水写入在**同一事务**内 —— 不允许出现「余额变了却没有流水」或反之。
   */
  deductCredits(userId: string, amount: number, entry: LedgerEntry): User | null {
    const tx = this.db.transaction((): User | null => {
      const row = this.db.prepare('SELECT credits FROM users WHERE id = ?').get(userId) as { credits: number } | undefined
      if (!row || row.credits < amount) return null
      this.db.prepare('UPDATE users SET credits = credits - ?, updated_at = ? WHERE id = ?').run(amount, nowIso(), userId)
      this.insertLedger(userId, -amount, entry)
      return this.getUserById(userId)
    })
    return tx()
  }

  /** 加额。`entry` 必填：没有来源的额度变动等于不可对账（与余额更新同事务） */
  addCredits(userId: string, amount: number, entry: LedgerEntry): User {
    const tx = this.db.transaction((): User => {
      this.db.prepare('UPDATE users SET credits = credits + ?, updated_at = ? WHERE id = ?').run(amount, nowIso(), userId)
      this.insertLedger(userId, amount, entry)
      return this.getUserById(userId)!
    })
    return tx()
  }

  /** 写一条额度流水。只应在 addCredits / deductCredits / createUser 的事务内被调用 */
  insertLedger(userId: string, delta: number, entry: LedgerEntry): void {
    this.db
      .prepare('INSERT INTO credit_ledger (user_id, delta, source, ref_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(userId, delta, entry.source, entry.refId ?? null, entry.note ?? null, nowIso())
  }

  /** 某人的额度流水，倒序（按 id，避免同毫秒并列时顺序不定） */
  listLedger(filter: { userId?: string; source?: CreditSource; limit?: number; offset?: number }): LedgerRow[] {
    const clauses: string[] = []
    const params: string[] = []
    if (filter.userId) {
      clauses.push('user_id = ?')
      params.push(filter.userId)
    }
    if (filter.source) {
      clauses.push('source = ?')
      params.push(filter.source)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.db
      .prepare(`SELECT * FROM credit_ledger ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, filter.limit ?? 50, filter.offset ?? 0) as LedgerDbRow[]
    return rows.map((r) => ({ id: r.id, userId: r.user_id, delta: r.delta, source: r.source as CreditSource, refId: r.ref_id, note: r.note, createdAt: r.created_at }))
  }

  countLedger(filter: { userId?: string; source?: CreditSource }): number {
    const clauses: string[] = []
    const params: string[] = []
    if (filter.userId) {
      clauses.push('user_id = ?')
      params.push(filter.userId)
    }
    if (filter.source) {
      clauses.push('source = ?')
      params.push(filter.source)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    return (this.db.prepare(`SELECT COUNT(*) AS c FROM credit_ledger ${where}`).get(...params) as { c: number }).c
  }

  /** 记录邀请成功；返回受赠额度（受上限约束）。inviteeId 用于流水溯源「这笔奖励是谁带来的」 */
  recordInvite(inviterId: string, reward: number, inviteeId: string): void {
    this.db.prepare('UPDATE users SET invited_count = invited_count + 1, updated_at = ? WHERE id = ?').run(nowIso(), inviterId)
    if (reward > 0) this.addCredits(inviterId, reward, { source: 'invite_reward', refId: inviteeId, note: '邀请奖励' })
  }

  countUsersByRole(role: UserRole): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM users WHERE role = ?').get(role) as { c: number }
    return row.c
  }

  /** 管理端用户列表。复用 rowToUser 同一条行映射，避免两处字段漂移 */
  listUsers(filter: { q?: string; role?: UserRole; status?: UserStatus; limit?: number; offset?: number }): User[] {
    const { where, params } = userWhere(filter)
    const rows = this.db
      .prepare(`SELECT * FROM users ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...params, filter.limit ?? 50, filter.offset ?? 0) as UserRow[]
    return rows.map(rowToUser)
  }

  countUsers(filter: { q?: string; role?: UserRole; status?: UserStatus }): number {
    const { where, params } = userWhere(filter)
    return (this.db.prepare(`SELECT COUNT(*) AS c FROM users ${where}`).get(...params) as { c: number }).c
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

  /**
   * 按会话 token 解析用户。**被禁用的用户一律解析为 null** —— 这是契约要求的：
   * 禁用后既有会话必须失效，否则「禁用」只是把会话删掉，用户重新登录即可拿回全部权限。
   * 放在这一层是因为它是所有会话态鉴权的唯一收口（页面守卫、requireUser、requireRole 都经过它）。
   */
  getUserBySession(token: string): User | null {
    const row = this.db
      .prepare('SELECT user_id FROM sessions WHERE token = ? AND expires_at > ?')
      .get(this.hashToken(token), nowIso()) as { user_id: string } | undefined
    if (!row) return null
    const user = this.getUserById(row.user_id)
    if (!user || user.status === 'disabled') return null
    return user
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
      // 退额必须走 addCredits：内联改 credits 会绕过流水，让「账目与余额一致」的不变式
      // 在「用户取消排队任务」这一条路径上破掉（而这条路径原本没有任何测试覆盖）
      this.addCredits(userId, row.requested_count, { source: 'generation_refund', refId: id, note: '取消排队中的生成' })
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
    /** 画布摆放；缺省则落 0 尺寸 0 位置 + 空 updated_at，由首次 GET 补位自愈 */
    placement?: { x: number; y: number; width: number; height: number }
  }): CanvasImage {
    const id = newCanvasImageId()
    const serial = this.nextSerial(input.topicId)
    const t = nowIso()
    const p = input.placement
    this.db
      .prepare(
        `INSERT INTO canvas_images (id, topic_id, user_id, message_id, origin, serial, name, image_key, mime_type, bytes, width, height, canvas_x, canvas_y, canvas_w, canvas_h, updated_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id, input.topicId, input.userId, input.messageId, input.origin, serial, input.name, input.imageKey,
        input.mimeType, input.bytes, input.width, input.height,
        p ? p.x : 0, p ? p.y : 0, p ? p.width : 0, p ? p.height : 0, p ? t : '', t
      )
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

  // ---------- 画布摆放与元信息（画布升级） ----------

  /** 画布元信息（视口/背景）：JSON 列，脏数据回退默认值 */
  getCanvasMeta(topicId: string): CanvasMeta {
    const row = this.db.prepare('SELECT canvas_meta FROM topics WHERE id = ?').get(topicId) as
      | { canvas_meta: string }
      | undefined
    return parseCanvasMeta(row?.canvas_meta)
  }

  /**
   * 写画布元信息。
   * ⚠️ **刻意不更新 topics.updated_at**：视口变更会防抖落库，若撞 updated_at，
   * watchTopic 长轮询会把每次平移判为「任务有变化」，导致整份 detail 重取 —— 平移变网络风暴。
   */
  setCanvasMeta(topicId: string, meta: CanvasMeta): void {
    this.db.prepare('UPDATE topics SET canvas_meta = ? WHERE id = ?').run(JSON.stringify(meta), topicId)
  }

  listCanvasPlacements(topicId: string): CanvasImagePlacement[] {
    const rows = this.db
      .prepare(
        'SELECT id, canvas_x, canvas_y, canvas_w, canvas_h, updated_at FROM canvas_images WHERE topic_id = ? ORDER BY serial'
      )
      .all(topicId) as Array<{
      id: string
      canvas_x: number
      canvas_y: number
      canvas_w: number
      canvas_h: number
      updated_at: string
    }>
    return rows.map((r) => ({
      id: r.id,
      canvasX: r.canvas_x,
      canvasY: r.canvas_y,
      canvasWidth: r.canvas_w,
      canvasHeight: r.canvas_h,
      updatedAt: r.updated_at,
    }))
  }

  /**
   * 批量 upsert 画布位置，**图片级 LWW**（比较 updated_at），单事务。
   * 返回 applied/rejected：rejected 含「图不存在」与「库中更新」两种，客户端据此回滚。
   * 归属校验由调用方（route）先做，此处再用 topic_id 兜一层，防跨任务写入。
   */
  upsertCanvasPlacements(
    topicId: string,
    placements: CanvasImagePlacement[]
  ): { applied: string[]; rejected: string[] } {
    const applied: string[] = []
    const rejected: string[] = []
    const read = this.db.prepare('SELECT updated_at FROM canvas_images WHERE id = ? AND topic_id = ?')
    const write = this.db.prepare(
      'UPDATE canvas_images SET canvas_x = ?, canvas_y = ?, canvas_w = ?, canvas_h = ?, updated_at = ? WHERE id = ? AND topic_id = ?'
    )
    const tx = this.db.transaction(() => {
      for (const p of placements) {
        const row = read.get(p.id, topicId) as { updated_at: string } | undefined
        if (!row) {
          rejected.push(p.id)
          continue
        }
        // 图片级 LWW：库中版本更新（且非空）时拒绝更旧的写入
        if (row.updated_at && row.updated_at > p.updatedAt) {
          rejected.push(p.id)
          continue
        }
        write.run(p.canvasX, p.canvasY, p.canvasWidth, p.canvasHeight, p.updatedAt, p.id, topicId)
        applied.push(p.id)
      }
    })
    tx()
    return { applied, rejected }
  }

  /**
   * 旧库补位：`updated_at` 为空的行（升级库的老行）按 serial 顺序分配空位槽并写回。
   * 幂等：写完 updated_at 非空，重复调用不再命中；已有非零位置的行不参与分配。
   */
  backfillCanvasPlacements(topicId: string): number {
    const pending = this.db
      .prepare(
        "SELECT id, width, height FROM canvas_images WHERE topic_id = ? AND updated_at = '' ORDER BY serial"
      )
      .all(topicId) as Array<{ id: string; width: number; height: number }>
    if (pending.length === 0) return 0
    const origin = viewportOrigin(this.getCanvasMeta(topicId).viewport)
    const occupied = this.listCanvasPlacements(topicId)
      .filter((p) => !pending.some((x) => x.id === p.id))
      .map(placementRect)
    const sizes = pending.map((p) => displaySize(p.width, p.height))
    const slots = allocateSlots(occupied, sizes, origin)
    const t = nowIso()
    // 逐行调 upsertCanvasPlacements：每行本身就是一条原子 UPDATE，且本方法幂等，
    // 故不再套一层外层事务（避免嵌套事务的语义负担）
    pending.forEach((row, i) => {
      this.upsertCanvasPlacements(topicId, [rectToPlacement(row.id, slots[i], t)])
    })
    return pending.length
  }

  // ---------- 暂存参考图（上传后、生成前；开始生成时转正为画布图） ----------

  insertReferenceUpload(input: {
    topicId: string
    userId: string
    name: string
    imageKey: string
    mimeType: string
    bytes: number
  }): StagedReference {
    const id = newReferenceUploadId()
    this.db
      .prepare(
        'INSERT INTO reference_uploads (id, topic_id, user_id, name, image_key, mime_type, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(id, input.topicId, input.userId, input.name, input.imageKey, input.mimeType, input.bytes, nowIso())
    return this.getReferenceUpload(id)!
  }

  getReferenceUpload(id: string): StagedReference | null {
    const r = this.db.prepare('SELECT * FROM reference_uploads WHERE id = ?').get(id) as
      | { id: string; topic_id: string; name: string; image_key: string; mime_type: string; bytes: number; created_at: string }
      | undefined
    if (!r) return null
    return {
      id: r.id,
      topicId: r.topic_id,
      name: r.name,
      imageKey: r.image_key,
      mimeType: r.mime_type,
      bytes: r.bytes,
      createdAt: r.created_at,
    }
  }

  deleteReferenceUpload(id: string): boolean {
    return this.db.prepare('DELETE FROM reference_uploads WHERE id = ?').run(id).changes > 0
  }

  listReferenceUploads(topicId: string): StagedReference[] {
    const rows = this.db.prepare('SELECT * FROM reference_uploads WHERE topic_id = ? ORDER BY created_at, id').all(topicId) as Array<{
      id: string
      topic_id: string
      name: string
      image_key: string
      mime_type: string
      bytes: number
      created_at: string
    }>
    return rows.map((r) => ({
      id: r.id,
      topicId: r.topic_id,
      name: r.name,
      imageKey: r.image_key,
      mimeType: r.mime_type,
      bytes: r.bytes,
      createdAt: r.created_at,
    }))
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

  createOrder(userId: string, pkg: CreditPackage, channel: 'mock' | 'epay' | 'stripe' = 'mock'): string {
    const id = newOrderId()
    this.db
      .prepare('INSERT INTO orders (id, user_id, package_id, credits, amount_total, currency, status, channel, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, userId, pkg.id, pkg.credits, pkg.amountTotal, pkg.currency, 'pending', channel, nowIso())
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

  /** 按订单号读取（含归属与渠道信息）：回调入账与 mock-pay 渠道隔离都用它 */
  getOrder(orderId: string): { id: string; userId: string; credits: number; amountTotal: number; status: string; channel: string } | undefined {
    const r = this.db
      .prepare('SELECT id, user_id, credits, amount_total, status, channel FROM orders WHERE id = ?')
      .get(orderId) as { id: string; user_id: string; credits: number; amount_total: number; status: string; channel: string } | undefined
    if (!r) return undefined
    return { id: r.id, userId: r.user_id, credits: r.credits, amountTotal: r.amount_total, status: r.status, channel: r.channel }
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

  // ---------- 生成日志（管理端跨用户视图）与清理 ----------

  /**
   * 跨用户生成轮次列表。含 `prompt` 原文与 `finalPrompt`（实际发往网关的提示词）——
   * 排障必须同时看到「用户说了什么」和「系统实际发了什么」。
   *
   * 排序用 `rowid DESC` 而不是 `created_at DESC`：同一毫秒内创建的多条记录无法靠时间区分，
   * 而 `id` 是随机 hex 前缀，按其倒序等于随机顺序（测试与页面都会看到不稳定的「最新一条」）。
   */
  listAllMessages(filter: { status?: MessageStatus; userId?: string; from?: string; to?: string; limit?: number; offset?: number }): AdminLogRow[] {
    const { where, params } = messageWhere(filter)
    const rows = this.db
      .prepare(
        `SELECT m.*, COALESCE(g.c, 0) AS generated_count
           FROM messages m
           LEFT JOIN (SELECT message_id, COUNT(*) AS c FROM canvas_images WHERE message_id IS NOT NULL GROUP BY message_id) g ON g.message_id = m.id
           ${where} ORDER BY m.rowid DESC LIMIT ? OFFSET ?`
      )
      .all(...params, filter.limit ?? 50, filter.offset ?? 0) as Array<MessageRow & { generated_count: number }>
    return rows.map((r) => ({
      id: r.id,
      topicId: r.topic_id,
      userId: r.user_id,
      prompt: r.prompt,
      finalPrompt: r.final_prompt,
      size: r.size,
      requestedCount: r.requested_count,
      status: r.status as MessageStatus,
      attempts: r.attempts,
      error: r.error,
      generatedCount: r.generated_count,
      createdAt: r.created_at,
    }))
  }

  countAllMessages(filter: { status?: MessageStatus; userId?: string; from?: string; to?: string }): number {
    const { where, params } = messageWhere(filter)
    return (this.db.prepare(`SELECT COUNT(*) AS c FROM messages m ${where}`).get(...params) as { c: number }).c
  }

  /**
   * 清理超期的**已终态**生成轮次，返回删除条数。
   *
   * 为什么必须是终态：messages 是「扣费 / 交付 / 退额」的唯一对账依据；非终态轮次的账还没结清，
   * 删掉就等于销毁未结清的账目。
   * 为什么不动 canvas_images：那是用户画布资产，且 `message_id` 不是外键，删 messages 只会留下
   * 悬空引用 —— 不删不会报错，但会永久丢失用户资产。
   * 同样不动 credit_ledger：流水是账目本身，与「日志保留期」是两件事。
   */
  cleanupMessagesBefore(before: string): number {
    const tx = this.db.transaction((): number => {
      return this.db
        .prepare("DELETE FROM messages WHERE created_at < ? AND status IN ('completed','failed','canceled')")
        .run(before).changes
    })
    return tx()
  }

  // ---------- feedback ----------

  insertFeedback(userId: string, content: string): void {
    this.db.prepare('INSERT INTO feedback (user_id, content, created_at) VALUES (?, ?, ?)').run(userId, content, nowIso())
  }

  /** 反馈列表（管理端） */
  listFeedback(filter: { status?: 'pending' | 'resolved'; limit?: number; offset?: number }): FeedbackRow[] {
    const { where, params } = feedbackWhere(filter)
    const rows = this.db
      .prepare(`SELECT * FROM feedback ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...params, filter.limit ?? 50, filter.offset ?? 0) as FeedbackDbRow[]
    return rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      content: r.content,
      status: r.status,
      resolvedAt: r.resolved_at,
      resolvedBy: r.resolved_by,
      createdAt: r.created_at,
    }))
  }

  countFeedback(filter: { status?: 'pending' | 'resolved' }): number {
    const { where, params } = feedbackWhere(filter)
    return (this.db.prepare(`SELECT COUNT(*) AS c FROM feedback ${where}`).get(...params) as { c: number }).c
  }

  /** 精确取一条反馈。作废/标记的前置存在性检查必须用它，不能用分页列表的 `some(...)` */
  getFeedback(id: number): FeedbackRow | null {
    const r = this.db.prepare('SELECT * FROM feedback WHERE id = ?').get(id) as FeedbackDbRow | undefined
    if (!r) return null
    return { id: r.id, userId: r.user_id, content: r.content, status: r.status, resolvedAt: r.resolved_at, resolvedBy: r.resolved_by, createdAt: r.created_at }
  }

  /** 标记已处理。条件 UPDATE 保证只有仍是 pending 时才写入 —— 不覆盖首个处理人（幂等拒绝） */
  resolveFeedback(id: number, actorId: string): boolean {
    const res = this.db
      .prepare("UPDATE feedback SET status = 'resolved', resolved_at = ?, resolved_by = ? WHERE id = ? AND status = 'pending'")
      .run(nowIso(), actorId, id)
    return res.changes === 1
  }

  // ---------- 概览指标 ----------

  overviewStats(now: string = nowIso()): AdminOverview {
    const one = <T>(sql: string, ...params: unknown[]): T => this.db.prepare(sql).get(...params) as T
    const n = (sql: string, ...params: unknown[]): number => one<{ c: number }>(sql, ...params).c
    const sevenDaysAgo = new Date(new Date(now).getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()

    const balance = one<{ s: number | null }>('SELECT SUM(credits) AS s FROM users').s ?? 0
    const sumLedger = (where: string, ...params: unknown[]): number =>
      one<{ s: number | null }>(`SELECT SUM(delta) AS s FROM credit_ledger WHERE ${where}`, ...params).s ?? 0

    const ledgerSum = sumLedger('1 = 1')
    // ⚠️ 取负的三处都要 `|| 0`：空表时 SUM 返回 NULL → `-0`，而 vitest 的 toBe 用 Object.is（`-0 !== 0`）
    const generatedCharged = -sumLedger("source = 'generation_charge'") || 0
    const refunded = sumLedger("source = 'generation_refund'") || 0
    const netSpent = generatedCharged - refunded || 0
    const granted = sumLedger("delta > 0 AND source NOT IN ('generation_refund', 'opening_balance', 'admin_adjust')")
    const openingBalance = sumLedger("source = 'opening_balance'")
    const adjustedIn = sumLedger("delta > 0 AND source = 'admin_adjust'")
    const adjustedOut = -sumLedger("delta < 0 AND source = 'admin_adjust'") || 0
    const bySource = this.db
      .prepare(
        `SELECT source,
                SUM(delta) AS net,
                SUM(CASE WHEN delta > 0 THEN delta ELSE 0 END) AS inflow,
                SUM(CASE WHEN delta < 0 THEN -delta ELSE 0 END) AS outflow
           FROM credit_ledger GROUP BY source ORDER BY net DESC, source ASC`
      )
      .all() as Array<{ source: CreditSource; net: number; inflow: number; outflow: number }>

    const terminal = n("SELECT COUNT(*) AS c FROM messages WHERE status IN ('completed','failed','canceled')")
    const succeeded = n("SELECT COUNT(*) AS c FROM messages WHERE status = 'completed'")

    return {
      users: {
        total: n('SELECT COUNT(*) AS c FROM users'),
        newLast7d: n('SELECT COUNT(*) AS c FROM users WHERE created_at >= ?', sevenDaysAgo),
      },
      credits: { balance, ledgerSum, granted, openingBalance, adjustedIn, adjustedOut, generatedCharged, refunded, netSpent, bySource },
      generations: {
        total: n('SELECT COUNT(*) AS c FROM messages'),
        terminal,
        succeeded,
        // 0/0 必须给 0：NaN 会被 JSON 序列化成 null，前端直接显示 "null%"
        successRate: terminal === 0 ? 0 : succeeded / terminal,
        topErrors: this.db
          .prepare(
            "SELECT error, COUNT(*) AS count FROM messages WHERE status = 'failed' AND error IS NOT NULL AND error <> '' GROUP BY error ORDER BY count DESC, error ASC LIMIT 3"
          )
          .all() as Array<{ error: string; count: number }>,
      },
      orders: {
        pending: n("SELECT COUNT(*) AS c FROM orders WHERE status = 'pending'"),
        paid: n("SELECT COUNT(*) AS c FROM orders WHERE status = 'paid'"),
        amountTotal: one<{ s: number | null }>("SELECT SUM(amount_total) AS s FROM orders WHERE status = 'paid'").s ?? 0,
      },
      cdks: {
        unredeemed: n('SELECT COUNT(*) AS c FROM cdks WHERE redeemed_by IS NULL AND revoked_at IS NULL'),
        redeemed: n('SELECT COUNT(*) AS c FROM cdks WHERE redeemed_by IS NOT NULL'),
        revoked: n('SELECT COUNT(*) AS c FROM cdks WHERE revoked_at IS NOT NULL'),
      },
      feedback: { pending: n("SELECT COUNT(*) AS c FROM feedback WHERE status = 'pending'") },
    }
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

  /** 审计保留清理：删除截止时间之前的记录，返回删除行数（回调端点防灌爆的配套机制） */
  deleteAuditBefore(cutoffIso: string): number {
    return this.db.prepare('DELETE FROM admin_audit WHERE created_at < ?').run(cutoffIso).changes as number
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

  /**
   * 审计流水的管理端分页视图。**刻意与 `listAudit` 并存**：后者返回裸数组且被多处既有测试断言依赖，
   * 改它的返回值形状的代价大于新增一个方法。
   */
  listAuditPaged(filter: { actorId?: string; action?: string; from?: string; to?: string; limit?: number; offset?: number }): AuditLogRow[] {
    const { where, params } = auditWhere(filter)
    const rows = this.db
      .prepare(`SELECT * FROM admin_audit ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, filter.limit ?? 50, filter.offset ?? 0) as AuditRow[]
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

  countAudit(filter: { actorId?: string; action?: string; from?: string; to?: string }): number {
    const { where, params } = auditWhere(filter)
    return (this.db.prepare(`SELECT COUNT(*) AS c FROM admin_audit ${where}`).get(...params) as { c: number }).c
  }

  // ---------- 配置（settings 键值表）----------

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    // 显式返回 null 而不是 ''：空串与「未设置」必须是两个状态，播种与 env 回退都依赖这个区分
    return row ? row.value : null
  }

  listSettings(): SettingRow[] {
    const rows = this.db
      .prepare('SELECT key, value, updated_at FROM settings ORDER BY key')
      .all() as Array<{ key: string; value: string; updated_at: string }>
    return rows.map((r) => ({ key: r.key, value: r.value, updatedAt: r.updated_at }))
  }

  /**
   * 播种：**仅在键不存在时**写入。返回 true 表示本次真的写了。
   *
   * 用 `ON CONFLICT DO NOTHING` 而不是「先 SELECT 再 INSERT」：后者在并发启动
   * （多进程同时拉起）时会双写，且多一次往返。
   */
  seedSetting(key: string, value: string): boolean {
    const info = this.db
      .prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING')
      .run(key, value, nowIso())
    return info.changes > 0
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(key, value, nowIso())
  }

  /** 批量写入：一个事务，要么全成要么全不成 —— 避免「一半配置已生效」这种无法解释的状态 */
  setSettings(entries: Array<{ key: string; value: string }>): void {
    const stmt = this.db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    const tx = this.db.transaction(() => {
      const t = nowIso()
      for (const e of entries) stmt.run(e.key, e.value, t)
    })
    tx()
  }

  /**
   * 删除配置行。用于「清空一个可选键」——
   * 清空必须是删除而不是写入空串，否则 env 回退会被一条空记录永久遮蔽。
   */
  deleteSettings(keys: string[]): void {
    if (keys.length === 0) return
    const stmt = this.db.prepare('DELETE FROM settings WHERE key = ?')
    const tx = this.db.transaction(() => {
      for (const k of keys) stmt.run(k)
    })
    tx()
  }

  // ---------- 提示词库（prompt_sources / prompt_entries）----------

  /**
   * 播种/同步源清单：**只覆盖清单列**，抓取状态列（entry_count / fetched_at /
   * last_success_at / last_error / signature）一律保留；**不在清单里的源连同其条目一起删掉**。
   *
   * 为什么按这个方向：清单的真相在代码里（改源地址只需改代码、重启即生效），
   * 而抓取状态只存在于库里（重启不该丢）。`sort_index` 用数组下标 ⇒ 调整清单顺序即生效。
   *
   * 为什么要删：不删的话，从清单里去掉一个源（例如只保留 GPT 系）之后，它的行与条目
   * 会一直留着，用户仍能在「来源」筛选栏里挑到它 —— 代码说没有、界面说有。
   * 删除走外键级联，该源的条目一并消失；重新加回清单时会从零重抓（可接受）。
   */
  seedPromptSources(defs: readonly PromptSourceDefInput[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO prompt_sources (id, name, url, homepage, sort_index) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, url = excluded.url,
         homepage = excluded.homepage, sort_index = excluded.sort_index`
    )
    const del = this.db.prepare('DELETE FROM prompt_sources WHERE id NOT IN (SELECT value FROM json_each(?))')
    const tx = this.db.transaction(() => {
      defs.forEach((d, i) => stmt.run(d.id, d.name, d.url, d.homepage, i))
      del.run(JSON.stringify(defs.map((d) => d.id)))
    })
    tx()
  }

  listPromptSources(): PromptSourceRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, name, url, homepage, sort_index, entry_count, fetched_at, last_success_at, last_error, signature
         FROM prompt_sources ORDER BY sort_index, id`
      )
      .all() as Array<{
      id: string
      name: string
      url: string
      homepage: string
      sort_index: number
      entry_count: number
      fetched_at: string | null
      last_success_at: string | null
      last_error: string
      signature: string
    }>
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      url: r.url,
      homepage: r.homepage,
      sortIndex: r.sort_index,
      entryCount: r.entry_count,
      fetchedAt: r.fetched_at,
      lastSuccessAt: r.last_success_at,
      lastError: r.last_error,
      signature: r.signature,
    }))
  }

  /**
   * 抓取成功：**整源原子替换**（同一事务内先删后插，再更新状态列）。
   *
   * 为什么必须同事务：中途失败会留下「一半新一半旧」的条目集，而列表页据此展示、
   * 用户据此挑选，半截状态无法解释也无法自愈。⚠️ 一律走同一个 `Database` 连接 ——
   * SQLite 同文件多连接下 WAL 视图不同，而 worker 持有的是同一个 store 实例。
   */
  replacePromptEntries(
    sourceId: string,
    entries: readonly PromptEntryInput[],
    meta: { signature: string; now: string }
  ): void {
    const del = this.db.prepare('DELETE FROM prompt_entries WHERE source_id = ?')
    const ins = this.db.prepare(
      `INSERT INTO prompt_entries
         (source_id, id, title, prompt, description, cover_url, reference_image_urls, tags, author, source_url, sort_index)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const upd = this.db.prepare(
      `UPDATE prompt_sources
       SET entry_count = ?, fetched_at = ?, last_success_at = ?, last_error = '', signature = ?
       WHERE id = ?`
    )
    const tx = this.db.transaction(() => {
      del.run(sourceId)
      entries.forEach((e, i) =>
        ins.run(
          sourceId,
          e.id,
          e.title,
          e.prompt,
          e.description,
          e.coverUrl,
          JSON.stringify(e.referenceImageUrls),
          JSON.stringify(e.tags),
          e.author,
          e.sourceUrl,
          i
        )
      )
      upd.run(entries.length, meta.now, meta.now, meta.signature, sourceId)
    })
    tx()
  }

  /**
   * 抓取失败：只更新 `fetched_at`（最近一次尝试）、`last_error` 与 `signature`。
   * 条目、`entry_count`、`last_success_at` 全部保留 —— 旧快照继续服役。
   *
   * 为什么失败也记 `signature`：它的语义是「最近一次抓取**尝试**时用的源定义签名」。
   * 若只在成功时记，一个从未成功过的源签名恒为空串，`isSourceStale` 会**每次读都判陈旧**，
   * 失败源的重试节奏就失效了（等于每次打开提示词库都去敲一遍死源）。
   * 记上之后：源地址没改 ⇒ 由 TTL 节奏控制；源地址改了 ⇒ 签名不匹配 ⇒ 立刻重抓。
   */
  recordPromptSourceFailure(sourceId: string, error: string, now: string, signature: string): void {
    this.db
      .prepare('UPDATE prompt_sources SET fetched_at = ?, last_error = ?, signature = ? WHERE id = ?')
      .run(now, error.slice(0, 300), signature, sourceId)
  }

  /**
   * 读全部条目（含源名）。库规模在万级以内，全量读 + 内存筛选足够；
   * 筛选/分面/分页都放在纯函数层，故这里不写任何 WHERE。
   */
  listPromptEntries(): PromptEntryRow[] {
    const rows = this.db
      .prepare(
        `SELECT e.source_id, s.name AS source_name, e.id, e.title, e.prompt, e.description,
                e.cover_url, e.reference_image_urls, e.tags, e.author, e.source_url, e.sort_index
         FROM prompt_entries e JOIN prompt_sources s ON s.id = e.source_id
         ORDER BY s.sort_index, e.sort_index`
      )
      .all() as Array<{
      source_id: string
      source_name: string
      id: string
      title: string
      prompt: string
      description: string
      cover_url: string
      reference_image_urls: string
      tags: string
      author: string
      source_url: string
      sort_index: number
    }>
    return rows.map((r) => ({
      sourceId: r.source_id,
      sourceName: r.source_name,
      id: r.id,
      title: r.title,
      prompt: r.prompt,
      description: r.description,
      coverUrl: r.cover_url,
      referenceImageUrls: safeParseIds(r.reference_image_urls),
      tags: safeParseIds(r.tags),
      author: r.author,
      sourceUrl: r.source_url,
      sortIndex: r.sort_index,
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
