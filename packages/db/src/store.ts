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
  topicStatusFromMessage,
  isBusyTopicStatus,
  BUSY_TOPIC_STATUS_VALUES,
  ACTIVE_MESSAGE_STATUS_VALUES,
  type CanvasImage,
  type CanvasImagePlacement,
  type CanvasMeta,
  type CanvasRect,
  type CreditPackage,
  type CreditSource,
  type Message,
  type MessageStatus,
  type StagedReference,
  type Topic,
  type TopicDetail,
  type TopicStatus,
  type User,
  type UserRole,
  type UserStatus,
} from '@motif/core'
import { applySchema } from './schema'

function nowIso(): string {
  return new Date().toISOString()
}

/** 读取自愈落定后的 topic 态（由同一份派生函数给出，不写字面量） */
const SETTLED_TOPIC_STATUS = topicStatusFromMessage(null)

const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(',')

/**
 * 「按人筛选」把筛选词解析成 ID 集合时的**上限**（`findUserIdsByTerm`）。
 *
 * 为什么必须有上限：筛选是「缩小范围」而不是「全量列举」。不设上限的话，一个空泛的词
 * （如「@」）会把 IN 子句撑到 SQLite 的变量上限（默认 999），整条查询直接报错。
 *
 * ⚠️ 命中超过上限时**静默截断**（只取前 100 个，按 `created_at DESC, id DESC`）：
 * 调用方拿到的是一个子集，但**没有任何标记**告诉它「还有更多」—— 页面因此会把子集
 * 当作完整的筛选结果展示。要让运营看见，得让接口回一个 `truncated` 标记并在页面上提示，
 * 那是接口契约的改动，不在本次收口范围（此处只把魔数提为具名常量并写明这一取舍）。
 */
const USER_TERM_MATCH_LIMIT = 100

/**
 * 读取自愈的 WHERE 片段：topic 声称在跑，但活跃消息已不在跑（含 `active_message_id` 为空）。
 *
 * ⚠️ 两个状态清单都从 `@motif/core` 取，**不在此处抄字面量** —— 抄一份就意味着
 * 将来改了「在跑」的定义，自愈判据会与 UI 的口径悄悄分叉。
 */
const STALE_TOPIC_WHERE = `status IN (${placeholders(BUSY_TOPIC_STATUS_VALUES.length)})
   AND (active_message_id IS NULL OR NOT EXISTS (
     SELECT 1 FROM messages m
     WHERE m.id = topics.active_message_id AND m.status IN (${placeholders(ACTIVE_MESSAGE_STATUS_VALUES.length)})
   ))`

/** reference_ids 列为 JSON 数组字符串；容错解析历史脏数据 */
function safeParseIds(raw: string | null | undefined): string[] {
  try {
    const v = JSON.parse(raw || '[]')
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

/**
 * slot_plan 列为 JSON 矩形数组；容错解析。
 *
 * ⚠️ 逐项校验形状（不是只判 `Array.isArray`）：槽位坐标会直接喂给 `left/top/width/height`，
 * 坏值（`"abc"` / NaN / 负尺寸）会渲染出诡异的占位块，比「没有骨架」更糟。
 * 单项不合法就丢弃该项 —— 骨架数偏少只是少一个占位，不会让整份计划失效。
 */
function safeParseSlotPlan(raw: string | null | undefined): CanvasRect[] {
  try {
    const v = JSON.parse(raw || '[]')
    if (!Array.isArray(v)) return []
    return v.filter(
      (r): r is CanvasRect =>
        !!r &&
        typeof r === 'object' &&
        [r.x, r.y, r.w, r.h].every((n) => typeof n === 'number' && Number.isFinite(n)) &&
        r.w > 0 &&
        r.h > 0
    )
  } catch {
    return []
  }
}

/**
 * 把「按用户筛选」落成 SQL 片段（list / count 共用，审计与生成日志口径一致）。
 *
 * 为什么有 `userIds` 与 `userId` 两种形态：`userId` 是**裸 ID 精确匹配**（历史写法，测试与
 * 既有调用点依赖）；`userIds` 是「筛选词解析出的候选集」—— 运营按邮箱/昵称筛选时先解析成人，
 * 再按 IN 查流水。两者互斥，`userIds` 优先。
 *
 * ⚠️ 空数组必须落成恒假条件（`1 = 0`）：调用方给空数组的语义是「这个词没匹配到任何人」，
 * 若当成「没有筛选条件」跳过，页面会返回**全量**数据 —— 那是比不筛选更糟的误导。
 */
function userScopeWhere(column: string, filter: { userId?: string; userIds?: string[] }): { clause: string | null; params: string[] } {
  if (filter.userIds !== undefined) {
    if (filter.userIds.length === 0) return { clause: '1 = 0', params: [] }
    return { clause: `${column} IN (${placeholders(filter.userIds.length)})`, params: [...filter.userIds] }
  }
  if (filter.userId) return { clause: `${column} = ?`, params: [filter.userId] }
  return { clause: null, params: [] }
}

/** 按操作者/动作/时间构造审计查询条件（供 list / count 共用）。action 用**精确匹配** —— 前缀匹配会让 credit.adjust 与 credit.adjust.rollback 互相污染 */
function auditWhere(filter: { actorId?: string; userIds?: string[]; action?: string; from?: string; to?: string }): { where: string; params: string[] } {
  const clauses: string[] = []
  const params: string[] = []
  const actor = userScopeWhere('actor_id', { userId: filter.actorId, userIds: filter.userIds })
  if (actor.clause) {
    clauses.push(actor.clause)
    params.push(...actor.params)
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
 * 用户摘要。管理端把裸 `usr_` ID 渲染成「昵称（邮箱）」用 ——
 * 只带展示必需的三列，**不带 credits / role / status**：它会被塞进列表接口的响应里，
 * 多余字段既扩大响应体，也容易让人误以为「列表接口顺带给了用户完整信息」。
 */
export interface UserBrief {
  id: string
  name: string
  email: string
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
function messageWhere(filter: { status?: MessageStatus; userId?: string; userIds?: string[]; from?: string; to?: string }): { where: string; params: string[] } {
  const clauses: string[] = []
  const params: string[] = []
  if (filter.status) {
    clauses.push('m.status = ?')
    params.push(filter.status)
  }
  const user = userScopeWhere('m.user_id', filter)
  if (user.clause) {
    clauses.push(user.clause)
    params.push(...user.params)
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
    // 三路命中，缺一不可：
    //  1. `id` 精确匹配 —— 运营从反馈/审计里看到的正是裸 `usr_` ID，原样贴进搜索框必须能定位到人
    //     （此前只搜邮箱/昵称，贴 ID 得到「共 0 个」，追溯链路是断的）
    //  2. 邮箱模糊匹配：邮箱统一小写存储，故用小写的 like 参数即可覆盖大小写
    //  3. 昵称模糊匹配：保持大小写敏感（不为此引入 LOWER() 全表扫描），中文昵称不受影响
    clauses.push('(id = ? OR email LIKE ? OR name LIKE ?)')
    const like = `%${filter.q.trim().toLowerCase()}%`
    params.push(filter.q.trim(), like, like)
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
function orderWhere(filter: { userId?: string; userIds?: string[]; status?: string; from?: string; to?: string }): { where: string; params: string[] } {
  const clauses: string[] = []
  const params: string[] = []
  const user = userScopeWhere('user_id', filter)
  if (user.clause) {
    clauses.push(user.clause)
    params.push(...user.params)
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
  orders: {
    /** 订单总数。**不能拿 paid + pending 现算** —— 概览卡要写「合计 N 笔」，而 status 列没有 CHECK 约束，
     *  靠两个已知状态相加会在出现第三种状态时静默少算。直接 COUNT(*) 才是唯一真相。 */
    total: number
    pending: number
    paid: number
    amountByCurrency: Array<{ currency: string; amountTotal: number }>
  }
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
  slot_plan: string
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
    slotPlan: safeParseSlotPlan(r.slot_plan),
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
   * 把一个筛选词解析成用户 ID 集合（审计 / 生成日志的「按用户筛选」用）。
   *
   * 为什么要解析而不是直接拿词去查流水：流水表里存的是裸 `usr_` ID。运营手上有的是
   * 邮箱或昵称（从工单、反馈里看来的），直接 `user_id = '张三'` 永远查不到东西，
   * 而页面上没有任何提示 —— 表现为「筛选点了没反应」。这里统一三路解析：
   * 精确 ID 优先（原样贴 ID 仍然可用），否则退化为邮箱 / 昵称模糊匹配。
   *
   * ⚠️ 上限见 `USER_TERM_MATCH_LIMIT`：超出即**静默截断**（返回子集，且不带「已截断」标记），
   * 页面会把子集当完整结果展示 —— 取舍与原因写在该常量的注释里。
   */
  findUserIdsByTerm(term: string, limit = USER_TERM_MATCH_LIMIT): string[] {
    const t = term.trim()
    if (!t) return []
    if (this.getUserById(t)) return [t]
    const like = `%${t.toLowerCase()}%`
    const rows = this.db
      .prepare('SELECT id FROM users WHERE email LIKE ? OR name LIKE ? ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(like, like, limit) as Array<{ id: string }>
    return rows.map((r) => r.id)
  }

  /**
   * 按 ID 批量取用户摘要（管理端把 `usr_` ID 渲染成「昵称（邮箱）」）。
   *
   * 一次 IN 查询而不是逐行 `getUserById`：列表一页 20 条，逐行查会变成 20 次往返；
   * 调用方（路由）负责把结果按 id 组成 Map 交给前端。
   * 去重后查询：同一个人可能在「提交用户」与「处理人」两列各出现一次。
   */
  listUserBriefs(ids: readonly string[]): UserBrief[] {
    const uniq = [...new Set(ids.filter((id) => !!id))]
    if (uniq.length === 0) return []
    const rows = this.db
      .prepare(`SELECT id, name, email FROM users WHERE id IN (${placeholders(uniq.length)})`)
      .all(...uniq) as Array<{ id: string; name: string; email: string }>
    return rows.map((r) => ({ id: r.id, name: r.name, email: r.email }))
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

  /**
   * 过期会话的持有者：**仅当**会话行存在、已过期、且账号仍存在时返回该用户，否则 null。
   *
   * 与 `getUserBySession` 的差别是**不按 expires_at 过滤**：后者把「过期」与「压根不存在」
   * 都收敛成 null，于是管理页只能给出通用 404，无法提示「登录已过期，请重新登录」（issue #75-3.4）。
   * 单独暴露过期态之后，页面守卫就能区分两种人：
   *  - 曾经持有真实会话、只是过期了（数据库里还留着那一行）→ 给过期引导
   *  - 随便带个 cookie 来探路的 → 仍是 404，不泄露管理面的存在性
   * 因此判据是「行存在且已过期」，而不是「token 无效」。
   *
   * ⚠️ 返回值是**用户**而不是布尔：调用方还要按角色裁决（普通用户带过期会话访问 /admin
   * 仍应得 404）。角色判断属服务层，不在这里做。
   */
  getExpiredSessionUser(token: string): User | null {
    const row = this.db.prepare('SELECT user_id, expires_at FROM sessions WHERE token = ?').get(this.hashToken(token)) as
      | { user_id: string; expires_at: string }
      | undefined
    if (!row) return null
    if (row.expires_at > nowIso()) return null
    return this.getUserById(row.user_id)
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
    const read = (): TopicRow | undefined => this.db.prepare('SELECT * FROM topics WHERE id = ?').get(id) as TopicRow | undefined
    const row = read()
    if (!row) return null
    // 读取自愈：只在 topic 自称在跑时才可能要做写（idle 是常见态，不该为它付一次写事务）
    if (isBusyTopicStatus(row.status) && this.settleStaleTopic(id)) {
      const healed = read()
      return healed ? rowToTopic(healed) : null
    }
    return rowToTopic(row)
  }

  listTopics(userId: string): Topic[] {
    const read = (): TopicRow[] =>
      this.db.prepare('SELECT * FROM topics WHERE user_id = ? ORDER BY updated_at DESC').all(userId) as TopicRow[]
    let rows = read()
    // 同 getTopic：只有存在自称在跑的任务时才尝试收敛
    if (rows.some((r) => isBusyTopicStatus(r.status)) && this.settleStaleTopicsOfUser(userId) > 0) {
      rows = read()
    }
    return rows.map(rowToTopic)
  }

  /** 「新任务」复用：当前用户最近更新的 idle 且 0 张画布图的会话（不存在则 null） */
  findReusableTopic(userId: string): Topic | null {
    // 也是读取路径：先自愈，否则「脏 pending」的空会话会一直不可复用，
    // 而复用判定与列表展示（listTopics 会自愈）就会出现「列表说空闲、却复用不到」的分叉。
    // 与 getTopic / listTopics 同口径：先判有没有脏状态，不为一次必然 no-op 的 UPDATE 付写事务。
    const stale = this.db
      .prepare(`SELECT COUNT(*) AS c FROM topics WHERE user_id = ? AND ${STALE_TOPIC_WHERE}`)
      .get(userId, ...BUSY_TOPIC_STATUS_VALUES, ...ACTIVE_MESSAGE_STATUS_VALUES) as { c: number }
    if (stale.c > 0) this.settleStaleTopicsOfUser(userId)
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

  /**
   * 直接写 topic 状态与活跃消息。
   *
   * ⚠️ **不要从外面调它**：状态必须由 `syncTopicStatus` 从消息状态派生，否则又回到
   * 「两边各写各的」那个根因（#81 / #86）。参数类型收窄成 `TopicStatus` 只是编译期兜底，
   * 真正的守卫是 `store.test.ts` 里那条扫全仓源码的机械断言。
   */
  setTopicActive(id: string, messageId: string | null, prompt: string | null, status: TopicStatus): void {
    this.db
      .prepare('UPDATE topics SET active_message_id = ?, active_prompt = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(messageId, prompt, status, nowIso(), id)
  }

  /**
   * **收口所有 `topics.status` 写入**：状态一律由消息状态经 `topicStatusFromMessage` 派生，
   * 不接受调用方直接给字面量。
   *
   * 为什么必须收口：topic 状态是**活跃生成轮次的投影**，两边各自写就会出现
   * 「任务说在停止、轮次早已失败」这类互相矛盾的中间态（#81 / #86 的共同根因）。
   */
  syncTopicStatus(topicId: string, messageId: string | null, prompt: string | null, msgStatus: MessageStatus | null): void {
    const status = topicStatusFromMessage(msgStatus)
    // 派生为 idle 时活跃消息/提示词必须一起清空 —— 否则会留下「话题空闲、却仍挂着一条终态消息」
    // 的半状态（读的人得自己判断那条消息算不算数）。状态与它携带的上下文必须同生同灭。
    const settled = status === SETTLED_TOPIC_STATUS
    this.setTopicActive(topicId, settled ? null : messageId, settled ? null : prompt, status)
  }

  /**
   * 读取自愈（单条）：topic 声称在跑、但活跃消息已不在跑时就地落定为 idle。
   *
   * 条件全在 UPDATE 的 WHERE 里，故「读-判-写」之间没有窗口：即便并发下判据已过期，
   * 语句也只会变成 no-op，不会误 settle 一个真正在跑的任务。
   *
   * @returns 真的落定了返回 `true`（调用方据此决定要不要重读）
   */
  private settleStaleTopic(id: string): boolean {
    const res = this.db
      .prepare(
        `UPDATE topics SET status = ?, active_message_id = NULL, active_prompt = NULL, updated_at = ?
         WHERE id = ? AND ${STALE_TOPIC_WHERE}`
      )
      .run(SETTLED_TOPIC_STATUS, nowIso(), id, ...BUSY_TOPIC_STATUS_VALUES, ...ACTIVE_MESSAGE_STATUS_VALUES)
    return res.changes > 0
  }

  /** 读取自愈（按用户批量）：语义同 `settleStaleTopic`，供列表读取一次性收敛 */
  private settleStaleTopicsOfUser(userId: string): number {
    const res = this.db
      .prepare(
        `UPDATE topics SET status = ?, active_message_id = NULL, active_prompt = NULL, updated_at = ?
         WHERE user_id = ? AND ${STALE_TOPIC_WHERE}`
      )
      .run(SETTLED_TOPIC_STATUS, nowIso(), userId, ...BUSY_TOPIC_STATUS_VALUES, ...ACTIVE_MESSAGE_STATUS_VALUES)
    return res.changes
  }

  /**
   * 顶起任务的 `updated_at`（`listTopics` 按 `ORDER BY updated_at DESC` 排序）。
   *
   * ⚠️ **会改变任务列表排序** —— 勿用于高频、无内容变化的场景：视口变更防抖落库即因此走
   * `setCanvasMeta` 刻意不 touch（否则每次平移都会把任务顶到列表最前，且触发 watchTopic
   * 长轮询重取整份 detail）。#88 里每落库一张图调一次属于「有内容变化」的正当用法。
   */
  touchTopic(id: string): void {
    this.db.prepare('UPDATE topics SET updated_at = ? WHERE id = ?').run(nowIso(), id)
  }

  /**
   * 删除任务（FK 级联清理行），返回需清理的存储对象 key 列表。
   *
   * ⚠️ **必须同时收 `reference_uploads`**（#61）：暂存参考图（上传了还没点生成）的对象
   * 只在这张表里有记录 —— 只查 `canvas_images` 会漏掉它们，删任务时那批文件永远留在盘/桶里。
   * 两张表都在 DELETE 之前读，故「取 key」与「删行」之间没有窗口。
   */
  deleteTopic(id: string): string[] {
    const rows = [
      ...(this.db.prepare('SELECT image_key FROM canvas_images WHERE topic_id = ?').all(id) as Array<{
        image_key: string
      }>),
      ...(this.db.prepare('SELECT image_key FROM reference_uploads WHERE topic_id = ?').all(id) as Array<{
        image_key: string
      }>),
    ]
    this.db.prepare('DELETE FROM topics WHERE id = ?').run(id)
    return rows.map((r) => r.image_key)
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
    /** 待生成槽位计划（#88）：入队时算好、随消息下发；缺省 = 无骨架（退回现场分配） */
    slotPlan?: CanvasRect[]
  }): Message {
    const id = newMessageId()
    const t = nowIso()
    this.db
      .prepare(
        `INSERT INTO messages (id, topic_id, user_id, prompt, final_prompt, size, requested_count, enhance_prompt, reference_ids, slot_plan, status, attempts, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?)`
      )
      .run(id, input.topicId, input.userId, input.prompt, input.finalPrompt, input.size, input.requestedCount, input.enhancePrompt ? 1 : 0, JSON.stringify(input.referenceIds ?? []), JSON.stringify(input.slotPlan ?? []), t)
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
      // 认领即把 topic 同步为「生成中」（#86）：由消息状态派生，与其余写入点同一口径。
      // 放在同一事务里 —— 不允许出现「消息在跑、任务仍显示排队中」的中间态被别的读看到。
      this.syncTopicStatus(row.topic_id, row.id, row.prompt, 'running')
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
   * 「请求取消」一条**正在运行**的消息：仅当仍为 `running` 时置 `canceling`（条件 UPDATE = CAS），
   * 且**保留租约列**（执行者还在跑，租约仍是「谁在执行」的唯一凭据；真正收尾在 `finalizeCancel`）。
   *
   * 为什么收进 store：`messages.status` 的写入必须全部收敛在存储层，才能用一条机械断言守住
   * 「计费/执行路径不得裸写消息状态」这条不变式（见 `store.test.ts` 的全仓扫描断言）。
   * 早先取消路由内联了这段 SQL —— 功能正确，但它让写入点散落在 apps/web 侧、断言无从覆盖。
   *
   * @returns 真的把状态翻成 `canceling` 返回 `true`；消息已不是 `running`（已被收尾/重排）返回 `false`
   */
  markMessageCanceling(id: string): boolean {
    const res = this.db
      .prepare(`UPDATE messages SET status = 'canceling' WHERE id = ? AND status = 'running'`)
      .run(id)
    return res.changes > 0
  }

  /**
   * 归还过期租约的消息（崩溃恢复）。
   * skipIds：本进程 worker 正在执行的消息——租约过期也不回收，避免「执行中→被重排→取消全额退」的双退额窗口。
   *
   * ⚠️ 同时回收**过期的 `canceling`**（#93）：这条路径以前只捞 `running`，于是「用户已点取消、
   * worker 在跑到取消检查点前被重启」的消息会**永久**卡在 canceling —— 既不会被重排回队列
   * （那会违背用户的取消意图），也走不到取消收尾，剩余额度永远不退、任务一直被 409 拦着。
   * 这里对它做的**不是重排**，而是直接走取消收尾（退额 + canceled + 任务回 idle）：与 `running`
   * 的回收共用「租约过期 = 执行侧确实没了」这同一个既有信号、同一个入口（这就是选修法 A 的理由 ——
   * 把回收放在同一个机制、同一个地方，而不是把退额副作用塞进读取路径）。
   */
  requeueExpiredLeases(skipIds: string[] = []): void {
    const skipPlaceholders = skipIds.map(() => '?').join(',')
    const skipClause = skipIds.length ? ` AND id NOT IN (${skipPlaceholders})` : ''
    const now = nowIso()
    // 先取回将被重排的消息，才能在同一个事务里把它们的 topic 一并同步回「排队中」。
    // ⚠️ 不同步的话会留下「消息已回 queued、任务仍显示 running」的不一致 ——
    // 而这正是本批要消灭的那类中间态（且它两侧都算「在跑」，读取自愈也修不了）。
    const rows = this.db
      .prepare(
        `SELECT id, topic_id, prompt FROM messages
         WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?${skipClause}`
      )
      .all(now, ...skipIds) as Array<{ id: string; topic_id: string; prompt: string }>
    if (rows.length > 0) {
      const tx = this.db.transaction((): void => {
        this.db
          .prepare(
            `UPDATE messages SET status = 'queued', worker_id = NULL, lease_token = NULL, lease_expires_at = NULL
             WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?${skipClause}`
          )
          .run(now, ...skipIds)
        for (const r of rows) this.syncTopicStatus(r.topic_id, r.id, r.prompt, 'queued')
      })
      tx()
    }

    // 过期 canceling：直接取消收尾（**不重排回 queued**）。逐条走 `finalizeCancel` 的原子 CAS ——
    // 只有把状态从 canceling 翻走的那一方退额，与仍活着的 worker 走到 `finishCancel` 天然互斥。
    // ⚠️ 这里要求 `lease_expires_at IS NOT NULL`：取消接口只把 running 翻成 canceling、**保留租约列**，
    // 故生产路径不会产生「canceling + 租约 NULL」这一组合（本批已确认）；真出现该组合时本路径不覆盖它。
    // 复用上面同一个 `now`（不再现取一次时间）。
    const canceling = this.db
      .prepare(
        `SELECT id FROM messages
         WHERE status = 'canceling' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?${skipClause}`
      )
      .all(now, ...skipIds) as Array<{ id: string }>
    for (const r of canceling) this.finalizeCancel(r.id, { leaseExpiredOnly: true, now })
  }

  /**
   * 取消收尾（原子 CAS + 退额）：把一条仍处于 `canceling` 的消息落定为 `canceled`，
   * 按「请求张数 − 已落库张数」退还剩余额度，并把任务同步回 idle（`syncTopicStatus` 是
   * topic 状态的唯一写入口，这里不裸写）。
   *
   * **互斥（本 issue 的命门）**：本函数有两个调用方 —— worker 跑到取消检查点后的收尾
   * （`apps/web` 的 `finishCancel`）与租约回收（`requeueExpiredLeases` 捞过期的 canceling，#93）。
   * 两者可能对同一条消息竞争。退额**只在 `UPDATE ... WHERE status = 'canceling'` 命中
   * （`changes === 1`）时**发生 —— 谁先把状态从 canceling 翻走谁退额，另一方 `changes === 0`、
   * 整体退化为 no-op。于是「回收后 worker 再走一次收尾」不会二次退额。
   *
   * 退额表达式与失败分支（`executeMessage` 的 catch）同源：`requestedCount − 已出图数`；
   * 全仓只有本函数一处实现「取消退额」，`finishCancel` 只是它的薄封装（防止两份实现漂移）。
   *
   * @param leaseExpiredOnly 只收尾「租约已过期」的消息（租约回收路径传 true：租约过期 =
   *   执行侧确实没了，绝不误伤仍在取消中的活任务）。worker 自己的收尾路径传 false ——
   *   它就是在执行的那一方，租约必然还活着。
   * @param now 租约判据用的时间戳；缺省取当前时刻。回收路径会传入它 SELECT 候选集时的同一个
   *   `now` —— 两次取值时点不同只会把候选集略微放大（无漏判），但复用同一个值能减少理解成本。
   * @returns 本次是否由自己完成收尾（`finalized === true` 时才真的退了额）
   */
  finalizeCancel(id: string, opts: { leaseExpiredOnly?: boolean; now?: string } = {}): { finalized: boolean; refund: number } {
    const tx = this.db.transaction((): { finalized: boolean; refund: number } => {
      const row = this.db
        .prepare('SELECT user_id, topic_id, requested_count FROM messages WHERE id = ?')
        .get(id) as { user_id: string; topic_id: string; requested_count: number } | undefined
      if (!row) return { finalized: false, refund: 0 }
      // 状态守卫与租约守卫一起进 WHERE：CAS 的判据全部落在同一条语句里，读-判-写之间没有窗口。
      const leaseGuard = opts.leaseExpiredOnly ? ' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?' : ''
      const params: string[] = opts.leaseExpiredOnly ? [id, opts.now ?? nowIso()] : [id]
      const res = this.db
        .prepare(
          `UPDATE messages SET status = 'canceled', worker_id = NULL, lease_token = NULL, lease_expires_at = NULL
           WHERE id = ? AND status = 'canceling'${leaseGuard}`
        )
        .run(...params)
      if (res.changes === 0) return { finalized: false, refund: 0 }
      const refund = row.requested_count - this.countGeneratedInMessage(id)
      // 退额必须走 addCredits：内联改 credits 会绕过流水，让「账目与余额一致」的不变式在取消路径上破掉。
      if (refund > 0) this.addCredits(row.user_id, refund, { source: 'generation_refund', refId: id, note: '取消退额' })
      this.syncTopicStatus(row.topic_id, null, null, 'canceled')
      return { finalized: true, refund }
    })
    return tx()
  }

  /**
   * 失败收尾（原子 CAS + 退额）：把一条**仍由本执行者持有**的 `running` 消息落定为 `failed`，
   * 按「请求张数 − 已落库张数」退还剩余额度，并把任务同步回 idle（`syncTopicStatus` 是 topic
   * 状态的唯一写入口，这里不裸写）。
   *
   * **守卫为什么是「状态 + 执行者身份」而不是只 `status='running'`**：唯一会与本方法争抢同一条
   * 消息的是 `requeueExpiredLeases`。它对过期 `running` 的处理是**重排回 `queued`**（不退额），
   * 重排后这条消息可能被**另一个进程**重新认领成 `running`（`worker_id` 变成那个进程）。若只守
   * `status='running'`，原进程迟到的 `catch` 会把这条**已被新执行者接管**的消息误判成自己的失败：
   * 既多退一次额，又把别人的在跑轮次打成 failed。加上 `worker_id = ?`（执行者身份）后，重排
   * 窗口内的原进程必然 `changes === 0` —— 身份要么是 NULL（刚被重排、尚未被认领），要么是新
   * 执行者的 id，都不等于原进程。（当前 `lease_token` 与 `worker_id` 在 `leaseNextMessage` 里被
   * 写成同一个值，故只守 `worker_id` 与同时守两者等价；将来若把 `lease_token` 改成独立随机令牌，
   * 这里应改守它 —— 见 `leaseNextMessage`。）
   *
   * 退额**只在 `changes === 1` 时**发生；与 `finalizeCancel` 同构，`executeMessage` 的 catch 是唯一调用方。
   *
   * @param opts.workerId 调用方（执行者）的 worker id：`leaseNextMessage` 认领时写入 `worker_id` 的那个值。
   * @param opts.buildError 由调用方提供的失败文案格式化器（文案是 UI 关注点，且要带退额张数）。
   *   只在 CAS 命中后才被调用，回传的 `refund` 与本方法退额数同源 —— 避免调用方自己算一遍导致漂移。
   * @returns `finalized === true` 时才真的退了额（`refund` 为本次退的张数）。
   */
  finalizeFailure(
    id: string,
    opts: { workerId: string; buildError: (refund: number) => string }
  ): { finalized: boolean; refund: number } {
    const tx = this.db.transaction((): { finalized: boolean; refund: number } => {
      // 先读 row 再 CAS：row 缺失时返回「未收尾」且**不写任何状态**，返回值语义与副作用一致
      // （同一事务内 CAS 命中后 row 不可能消失，故「已置 failed 却返回 finalized:false」不可达）。
      const row = this.db
        .prepare('SELECT user_id, topic_id, requested_count FROM messages WHERE id = ?')
        .get(id) as { user_id: string; topic_id: string; requested_count: number } | undefined
      if (!row) return { finalized: false, refund: 0 }
      // CAS：状态与执行者身份一起进 WHERE —— 判据全落在同一条语句里，读-判-写之间没有窗口。
      const res = this.db
        .prepare(
          `UPDATE messages SET status = 'failed', worker_id = NULL, lease_token = NULL, lease_expires_at = NULL
           WHERE id = ? AND status = 'running' AND worker_id = ?`
        )
        .run(id, opts.workerId)
      if (res.changes === 0) return { finalized: false, refund: 0 }
      const refund = row.requested_count - this.countGeneratedInMessage(id)
      this.db.prepare('UPDATE messages SET error = ? WHERE id = ?').run(opts.buildError(refund), id)
      // 退额必须走 addCredits：内联改 credits 会绕过流水，让「账目与余额一致」的不变式在失败路径上破掉。
      if (refund > 0) this.addCredits(row.user_id, refund, { source: 'generation_refund', refId: id, note: '生成失败退额' })
      this.syncTopicStatus(row.topic_id, null, null, 'failed')
      return { finalized: true, refund }
    })
    return tx()
  }

  /**
   * 成功收尾（原子 CAS）：把一条**仍由本执行者持有**的 `running` 消息落定为 `completed` 并清租约，
   * 命中时把任务同步回 idle（`syncTopicStatus` 是 topic 状态的唯一写入口，这里不裸写）。
   *
   * **守卫为什么是「状态 + 执行者身份」**：与 `finalizeFailure` 同构 —— 唯一会与它争抢同一条消息的
   * 是 `requeueExpiredLeases`（过期 `running` 重排回 `queued`，随后可能被**另一个进程**重新认领成
   * `running`）。若无守卫，迟到的成功分支会覆盖并发的 `canceling/failed`（把用户已取消的轮次标成
   * 已完成），或把另一位执行者的在跑轮次标成 `completed`、并让后者的 CAS 静默 no-op。
   *
   * ⚠️ 命中才落 completed + 同步 topic：CAS 落空时整体 no-op，**不碰 topic** —— 避免
   * 「CAS 未命中却把任务标成已完成」的不一致（这正是无守卫写入的旧行为）。
   *
   * @param opts.workerId 调用方（执行者）的 worker id：`leaseNextMessage` 认领时写入 `worker_id` 的那个值。
   * @returns `finalized === true` 时才真的落了 completed
   */
  finalizeSuccess(id: string, opts: { workerId: string }): { finalized: boolean } {
    const tx = this.db.transaction((): { finalized: boolean } => {
      const row = this.db.prepare('SELECT topic_id FROM messages WHERE id = ?').get(id) as { topic_id: string } | undefined
      if (!row) return { finalized: false }
      const res = this.db
        .prepare(
          `UPDATE messages SET status = 'completed', worker_id = NULL, lease_token = NULL, lease_expires_at = NULL
           WHERE id = ? AND status = 'running' AND worker_id = ?`
        )
        .run(id, opts.workerId)
      if (res.changes === 0) return { finalized: false }
      this.syncTopicStatus(row.topic_id, null, null, 'completed')
      return { finalized: true }
    })
    return tx()
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
      this.syncTopicStatus(row.topic_id, null, null, 'canceled')
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

  /**
   * 全库仍在册的存储对象 key（#58：搬迁只搬这些；#61：孤儿判定也用它）。
   *
   * 为什么需要：`storage:migrate` 只扫本地目录，于是「DB 行已删、本地文件还在」的孤儿对象
   * 会被当成「远端没有 → 待上传」而**重新上传**，桶里持续堆积。按在册 key 过滤即可根治。
   *
   * ⚠️ **必须并上 `reference_uploads`**（#61）：暂存参考图的对象只在那张表里有记录。
   * 只查 `canvas_images` 会让它们被误判成孤儿 —— 轻则搬迁时被跳过（切到 s3 后桶里没有它），
   * 重则被 `--prune-orphans` 当垃圾删掉（用户刚上传的参考图凭空消失）。
   * 只回 key、不碰配置 —— 调用方（CLI）自己决定怎么用。
   */
  listAllImageKeys(): string[] {
    const rows = [
      ...(this.db.prepare('SELECT image_key FROM canvas_images').all() as Array<{ image_key: string }>),
      ...(this.db.prepare('SELECT image_key FROM reference_uploads').all() as Array<{ image_key: string }>),
    ]
    return rows.map((r) => r.image_key)
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

  listOrders(filter: { userId?: string; userIds?: string[]; status?: string; from?: string; to?: string; limit?: number; offset?: number }): Array<{
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

  countOrders(filter: { userId?: string; userIds?: string[]; status?: string; from?: string; to?: string }): number {
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
  listAllMessages(filter: { status?: MessageStatus; userId?: string; userIds?: string[]; from?: string; to?: string; limit?: number; offset?: number }): AdminLogRow[] {
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

  countAllMessages(filter: { status?: MessageStatus; userId?: string; userIds?: string[]; from?: string; to?: string }): number {
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
        total: n('SELECT COUNT(*) AS c FROM orders'),
        pending: n("SELECT COUNT(*) AS c FROM orders WHERE status = 'pending'"),
        paid: n("SELECT COUNT(*) AS c FROM orders WHERE status = 'paid'"),
        // 按币种分组求和：币种是后台可配的（改过配置后历史订单会留下别的币种），
        // 跨币种直接 SUM 会得到一个没有意义的数，展示层也无从推断该配哪个符号。
        amountByCurrency: this.db
          .prepare(
            "SELECT currency, SUM(amount_total) AS amountTotal FROM orders WHERE status = 'paid' GROUP BY currency ORDER BY amountTotal DESC"
          )
          .all() as Array<{ currency: string; amountTotal: number }>,
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
  listAuditPaged(filter: { actorId?: string; userIds?: string[]; action?: string; from?: string; to?: string; limit?: number; offset?: number }): AuditLogRow[] {
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

  countAudit(filter: { actorId?: string; userIds?: string[]; action?: string; from?: string; to?: string }): number {
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
