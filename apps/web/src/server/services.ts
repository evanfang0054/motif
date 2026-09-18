import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import {
  SIGNUP_BONUS_CREDITS,
  inviteRewardFor,
  validateEmail,
  validateName,
  validatePassword,
  validatePrompt,
  validateSize,
  type CanvasImage,
  type GenerateImagesInput,
  type GenerateImagesResponse,
  type Topic,
  type User,
} from '@motif/core'
import { buildImageKey, storagePathFor, type MotifStore } from '@motif/db'
import type { ImageProvider } from '@motif/image-provider'
import { hashPassword, verifyPassword, SESSION_TTL_MS } from './auth'
import type { MailerConfig } from './mailer'
import { checkRate } from './rate-limit'
import { resolveBool, resolveSetting } from './settings'

export class ServiceError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

// ---------- auth ----------

export async function sendCode(
  store: MotifStore,
  mailer: MailerConfig,
  purpose: 'register' | 'password-reset',
  email: string,
  ip?: string
): Promise<{ sent: true; devCode?: string; via: string }> {
  const err = validateEmail(email)
  if (err) throw new ServiceError(400, err)
  // 防邮件轰炸/防爆破：每邮箱 60s 冷却 + 每小时 5 封；每 IP 每小时 30 封
  if (!checkRate(`code:email:${email.toLowerCase()}`, 60_000, 1)) {
    throw new ServiceError(429, '发送过于频繁，请 1 分钟后再试。')
  }
  if (!checkRate(`code:email1h:${email.toLowerCase()}`, 3_600_000, 5)) {
    throw new ServiceError(429, '该邮箱验证码发送次数已达上限，请稍后再试。')
  }
  if (ip && !checkRate(`code:ip:${ip}`, 3_600_000, 30)) {
    throw new ServiceError(429, '请求过于频繁，请稍后再试。')
  }
  const code = store.createVerificationCode(purpose, email, 1000 * 60 * 10)
  // 真实渠道（smtp/resend/sendgrid）发信；console 为本地直出（只打日志）
  await mailer.mailer.sendVerificationCode(email, code, purpose)
  // 安全默认：devCode 回传仅限「console 渠道 + 非生产」或「显式开启直出开关」。
  // 开关读配置（数据库优先、回退环境变量），因此可以在管理后台危险区里热改。
  // ⚠️ 保留「非生产」这一半：本地开发默认直出是既有行为，改成纯开关会让本地注册流程拿不到验证码。
  const expose =
    mailer.isConsole && (process.env.NODE_ENV !== 'production' || resolveBool(store, process.env, 'MOTIF_EXPOSE_DEV_CODE'))
  return { sent: true, ...(expose ? { devCode: code } : {}), via: mailer.mailer.name }
}

/**
 * 管理后台测试发送：用当前生效渠道真实投递一封，失败透传底层原因（如 SMTP 535 授权码错误）。
 * 频控与 sendCode 对齐：每邮箱 60s/1 封、每小时 10 封——防 root 会话被劫持后滥用为轰炸跳板。
 */
export async function sendTestMail(mailer: MailerConfig, to: string): Promise<{ ok: true; via: string }> {
  const err = validateEmail(to)
  if (err) throw new ServiceError(400, err)
  if (!checkRate(`testmail:to:${to.toLowerCase()}`, 60_000, 1)) {
    throw new ServiceError(429, '发送过于频繁，请 1 分钟后再试。')
  }
  if (!checkRate(`testmail:to1h:${to.toLowerCase()}`, 3_600_000, 10)) {
    throw new ServiceError(429, '该邮箱测试发送次数已达上限，请稍后再试。')
  }
  try {
    await mailer.mailer.sendTest(to)
  } catch (e) {
    // 底层原因（SMTP 535 / Resend 401…）必须透传到页面：普通 Error 会被 jsonError 归一成 500 通用文案
    throw new ServiceError(502, `测试发送失败：${e instanceof Error ? e.message : String(e)}`)
  }
  return { ok: true, via: mailer.mailer.name }
}

export function register(
  store: MotifStore,
  input: { name: string; email: string; code: string; password: string; passwordConfirm: string; inviteCode?: string }
): User {
  for (const [check, err] of [
    [input.name, validateName(input.name || '')],
    [input.email, validateEmail(input.email || '')],
    [input.code, /^.{6}$/.test(input.code || '') ? null : '请输入 6 位邮箱验证码。'],
    [input.password, validatePassword(input.password || '')],
  ] as const) {
    if (err) throw new ServiceError(400, err)
  }
  if (input.password !== input.passwordConfirm) throw new ServiceError(400, '两次输入的密码不一致。')
  // 先消费验证码再做邮箱查重：避免「邮箱已注册」成为匿名可探测的枚举信号
  if (!store.consumeVerificationCode('register', input.email, input.code)) {
    throw new ServiceError(400, '验证码无效或已过期。')
  }
  if (store.getUserByEmail(input.email)) throw new ServiceError(409, '该邮箱已注册，请直接登录。')

  let invitedBy: string | null = null
  if (input.inviteCode && input.inviteCode.trim()) {
    const inviter = store.getUserByInviteCode(input.inviteCode.trim())
    if (inviter) invitedBy = inviter.id
  }

  const user = store.createUser({
    email: input.email,
    passwordHash: hashPassword(input.password),
    name: input.name.trim(),
    invitedBy,
    credits: 0, // 赠送额度改走 addCredits，好让流水里是语义正确的 signup_bonus 而不是期初结存
  })
  store.addCredits(user.id, SIGNUP_BONUS_CREDITS, { source: 'signup_bonus', note: '注册赠送' })

  if (invitedBy) {
    const inviter = store.getUserById(invitedBy)!
    const reward = invitedBy ? inviteRewardFor(inviter.invitedCount) : 0
    store.recordInvite(invitedBy, reward, user.id)
  }
  // ⚠️ 必须返回赠额之后的用户：直接 return 上面那个 user 会让注册接口带着 credits=0 出去
  return store.getUserById(user.id)!
}

export function login(store: MotifStore, email: string, password: string): User {
  const user = store.getUserByEmail(email || '')
  if (!user) throw new ServiceError(401, '邮箱或密码不正确。')
  const stored = store.getPasswordHash(user.id)
  if (!stored || !verifyPassword(password, stored)) throw new ServiceError(401, '邮箱或密码不正确。')
  // 禁用校验必须放在**验密之后**：先验密才不会向不知道密码的人泄露「这个账号存在且被禁了」。
  // 少了这一步，「禁用用户」就是假的 —— 被禁者拿密码即可重新登录并拿回全部权限。
  if (user.status === 'disabled') throw new ServiceError(401, '账号已被禁用，请联系管理员。')
  return user
}

export function resetPassword(
  store: MotifStore,
  input: { email: string; code: string; password: string }
): void {
  if (validateEmail(input.email)) throw new ServiceError(400, validateEmail(input.email)!)
  if (validatePassword(input.password)) throw new ServiceError(400, validatePassword(input.password)!)
  if (!store.consumeVerificationCode('password-reset', input.email, input.code)) {
    throw new ServiceError(400, '验证码无效或已过期。')
  }
  const user = store.getUserByEmail(input.email)
  if (!user) throw new ServiceError(404, '账号不存在。')
  store.updateUserPassword(user.id, hashPassword(input.password))
  // 凭证变更后吊销该账号全部会话（被盗会话立即失效）
  store.revokeUserSessions(user.id)
}

// ---------- topics ----------

export function assertOwnedTopic(store: MotifStore, userId: string, topicId: string): Topic {
  const topic = store.getTopic(topicId)
  if (!topic || topic.userId !== userId) throw new ServiceError(404, '任务不存在。')
  return topic
}

// ---------- generate ----------

export async function enqueueGeneration(
  store: MotifStore,
  provider: ImageProvider,
  dataDir: string,
  user: User,
  input: GenerateImagesInput
): Promise<GenerateImagesResponse> {
  const promptErr = validatePrompt(input.prompt || '')
  if (promptErr) throw new ServiceError(400, promptErr)
  const countErr = validateCountOf(input.count)
  if (countErr) throw new ServiceError(400, countErr)
  const sizeCheck = validateSize(input.size || '1024x1024')
  if (!sizeCheck.ok) throw new ServiceError(400, sizeCheck.error)

  // 确定任务：无 topicId 时以提示词摘要建新任务
  let topic = input.topicId ? store.getTopic(input.topicId) : null
  if (input.topicId) {
    if (!topic || topic.userId !== user.id) throw new ServiceError(404, '任务不存在。')
  } else {
    topic = store.createTopic(user.id, summarize(input.prompt))
  }

  if (topic.status === 'pending' || topic.status === 'running' || topic.status === 'canceling') {
    throw new ServiceError(409, '当前任务仍在生成中，请稍候。')
  }

  // 校验参考图归属：必须存在、属于当前用户与当前任务
  const validRefs: string[] = []
  for (const id of Array.isArray(input.referenceCanvasImageIds) ? input.referenceCanvasImageIds : []) {
    const img = store.getCanvasImage(id)
    if (!img || img.userId !== user.id || img.topicId !== topic.id) {
      throw new ServiceError(400, '参考图不存在或不属于当前任务。')
    }
    validRefs.push(id)
  }

  const cost = input.count
  // refId 留空：扣费发生在 createMessage 之前，此刻还没有消息 id（把扣费挪后又会改变
  // 「额度不足时不建 topic/message」的既有语义）
  const updated = store.deductCredits(user.id, cost, { source: 'generation_charge', refId: null, note: '入队扣费' })
  if (!updated) throw new ServiceError(402, '额度不足，请先充值。')

  const size = sizeCheck.value
  const message = store.createMessage({
    topicId: topic.id,
    userId: user.id,
    prompt: input.prompt.trim(),
    finalPrompt: input.prompt.trim(),
    size,
    requestedCount: input.count,
    enhancePrompt: !!input.enhance,
    referenceIds: validRefs,
  })
  store.setTopicActive(topic.id, message.id, input.prompt.trim(), 'pending')

  return {
    prompt: input.prompt.trim(),
    topic: store.getTopic(topic.id)!,
    messageId: message.id,
    queued: true,
    user: updated,
  }
}

function validateCountOf(count: number): string | null {
  if (!Number.isInteger(count) || count < 1 || count > 12) return '张数需在 1–12 之间。'
  return null
}

function summarize(prompt: string): string {
  const t = prompt.trim().replace(/\s+/g, ' ')
  return t.length > 18 ? t.slice(0, 18) : t || '新任务'
}

// ---------- worker 执行单条消息 ----------

export interface WorkerDeps {
  store: MotifStore
  provider: ImageProvider
  dataDir: string
  workerId: string
}

export async function executeMessage(deps: WorkerDeps, messageId: string): Promise<void> {
  const { store, provider, dataDir } = deps
  const msg = store.getMessage(messageId)
  if (!msg) return

  try {
    // 图生图：读取参考图文件传给 Provider（网关 images/edits 端点）
    const referenceImages = (msg.referenceIds ?? []).flatMap((id) => {
      const meta = store.getCanvasImage(id)
      if (!meta) return []
      try {
        return [{ buffer: readFileSync(storagePathFor(dataDir, meta.imageKey)), mimeType: meta.mimeType }]
      } catch {
        return [] // 参考图文件缺失时降级为纯文生图
      }
    })

    // 断点续跑：崩溃重排后从已生成数继续，只补剩余张数（额度守恒，防超发）
    const alreadyDone = store.countGeneratedInMessage(messageId)
    for (let i = alreadyDone; i < msg.requestedCount; i++) {
      // 取消检查：canceling 状态时停止并把剩余张数退回
      const current = store.getMessage(messageId)
      if (!current || current.status === 'canceling' || current.status === 'canceled') break

      const img = await provider.generate({
        prompt: msg.finalPrompt,
        size: msg.size,
        seedText: msg.id,
        referenceImages,
        indexInBatch: i,
      })
      const ext = img.mimeType.includes('png') ? 'png' : img.mimeType.includes('jpeg') ? 'jpg' : 'webp'
      const imageKey = buildImageKey(msg.userId, msg.topicId, msg.id, `${randomUUID()}.${ext}`)
      const abs = storagePathFor(dataDir, imageKey)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, img.buffer)
      store.insertCanvasImage({
        topicId: msg.topicId,
        userId: msg.userId,
        messageId: msg.id,
        origin: 'generated',
        name: `图片 ${i + 1}`,
        imageKey,
        mimeType: img.mimeType,
        bytes: img.buffer.length,
        width: img.width,
        height: img.height,
      })
    }

    const final = store.getMessage(messageId)
    const done = store.countGeneratedInMessage(messageId)
    if (final && (final.status === 'canceling' || final.status === 'canceled')) {
      finishCancel(store, msg, done)
    } else {
      store.setMessageStatus(messageId, 'completed')
      store.setTopicActive(msg.topicId, null, null, 'idle')
    }
  } catch (e) {
    const done = store.countGeneratedInMessage(messageId)
    const refund = msg.requestedCount - done
    if (refund > 0) store.addCredits(msg.userId, refund, { source: 'generation_refund', refId: messageId, note: '生成失败退额' })
    const raw = e instanceof Error ? e.message : String(e)
    console.error('[motif] 生成失败:', raw)
    store.setMessageStatus(messageId, 'failed', friendlyGenerateError(raw, refund))
    store.setTopicActive(msg.topicId, null, null, 'idle')
  }
}

/** 面向用户的失败文案：剥离网关原始 JSON，附带退额信息（原始错误走服务端日志） */
export function friendlyGenerateError(raw: string, refund: number): string {
  const refunded = refund > 0 ? `，已退还 ${refund} 张额度` : ''
  const code = raw.match(/生图接口失败（(\d+)）/)
  if (code) return `生图服务暂时不可用（网关 ${code[1]}）${refunded}`
  if (/timeout|timed?\s?out|abort|ETIMEDOUT|ECONN/i.test(raw)) return `生图请求超时${refunded}，请稍后重试`
  if (/余额不足|额度不足/.test(raw)) return raw.slice(0, 80)
  return `生成失败：${raw.slice(0, 60)}${refunded}`
}

export function finishCancel(store: MotifStore, msg: { id: string; topicId: string; requestedCount: number }, done: number): void {
  const refund = msg.requestedCount - done
  if (refund > 0) store.addCredits(store.getMessage(msg.id)!.userId, refund, { source: 'generation_refund', refId: msg.id, note: '取消退额' })
  store.setMessageStatus(msg.id, 'canceled')
  store.setTopicActive(msg.topicId, null, null, 'idle')
}

// ---------- 参考图上传 ----------

export function saveReferenceImage(
  store: MotifStore,
  dataDir: string,
  user: User,
  topicId: string,
  file: { buffer: Buffer; mimeType: string }
): CanvasImage {
  const topic = store.getTopic(topicId)
  if (!topic || topic.userId !== user.id) throw new ServiceError(404, '任务不存在。')
  const ext = file.mimeType.includes('png') ? 'png' : file.mimeType.includes('webp') ? 'webp' : 'jpg'
  const imageKey = buildImageKey(user.id, topicId, null, `${randomUUID()}.${ext}`)
  const abs = storagePathFor(dataDir, imageKey)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, file.buffer)
  return store.insertCanvasImage({
    topicId,
    userId: user.id,
    messageId: null,
    origin: 'uploaded',
    name: '参考图',
    imageKey,
    mimeType: file.mimeType,
    bytes: file.buffer.length,
    width: 0,
    height: 0,
  })
}

// ---------- billing / redeem ----------

export const CREDIT_PACKAGES = [
  { id: 'credits_50', label: '50 张额度', credits: 50, amountTotal: 868, currency: 'hkd' },
  { id: 'credits_100', label: '100 张额度', credits: 100, amountTotal: 1736, currency: 'hkd' },
  { id: 'credits_200', label: '200 张额度', credits: 200, amountTotal: 3472, currency: 'hkd' },
  { id: 'credits_500', label: '500 张额度', credits: 500, amountTotal: 8680, currency: 'hkd' },
]

/**
 * 校验 CDK 并到账。失败原因分三类给文案，让用户能分清「输错了 / 被作废了 / 已用过了」。
 *
 * 注意：这里的前置查询**只负责文案**。真正的裁决永远是 `store.redeemCdk` 内的条件 UPDATE，
 * 并发下仍只有一个请求能把 redeemed_by 从 NULL 写成自己 —— 前置查询与写入之间不存在
 * 「先查后写」的竞态漏洞（最坏情况是文案退化为「已被使用」，不会重复到账）。
 */
export function redeem(store: MotifStore, user: User, code: string): User {
  if (!code || !code.trim()) throw new ServiceError(400, '请输入 CDK。')
  const target = code.trim().toUpperCase()
  const cdk = store.getCdk(target)
  if (!cdk) throw new ServiceError(400, 'CDK 无效，请检查是否输入有误。')
  if (cdk.revokedAt) throw new ServiceError(400, '该 CDK 已失效，请联系发放方。')
  if (cdk.redeemedBy) throw new ServiceError(400, '该 CDK 已被使用。')

  const credits = store.redeemCdk(target, user.id)
  // 走到这里仍可能拿到 null：并发下另一个请求刚刚抢先兑换了同一张码
  if (credits === null) throw new ServiceError(400, '该 CDK 已被使用。')
  return store.addCredits(user.id, credits, { source: 'cdk_redeem', refId: target, note: 'CDK 兑换' })
}

/**
 * 计费模式：mock（演示收银台，默认）| live（预留真实支付渠道接入位）。
 * 安全基线：live 模式下 mock 支付端点一律 403，防止公开部署被"免费印钞"。
 * 取值读配置（数据库优先、回退环境变量），因此可在管理后台危险区里热改。
 */
export function billingMode(store: MotifStore): 'mock' | 'live' {
  return (resolveSetting(store, process.env, 'MOTIF_BILLING_MODE') ?? 'mock').toLowerCase() === 'live' ? 'live' : 'mock'
}
