import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import sharp from 'sharp'
import {
  DEFAULT_INVITE_REWARD_CREDITS,
  DEFAULT_INVITE_REWARD_MAX_INVITEES,
  DEFAULT_SIGNUP_BONUS_CREDITS,
  allocateSlots,
  displaySize,
  inviteRewardFor,
  placementRect,
  validateEmail,
  validateName,
  validatePassword,
  validatePrompt,
  validateReferenceCount,
  validateSize,
  viewportOrigin,
  type CanvasImage,
  type CreditPackage,
  type GenerateImagesInput,
  type GenerateImagesResponse,
  type Topic,
  type StagedReference,
  type User,
} from '@motif/core'
import { buildImageKey, type MotifStore } from '@motif/db'
import type { ImageProvider } from '@motif/image-provider'
import { hashPassword, verifyPassword, SESSION_TTL_MS } from './auth'
import type { MailerConfig } from './mailer'
import { resolveRemoteStorage, resolveStorage } from './context'
import { createLlmFromConfig } from './llm'
import { readImageWithFallback } from './storage'
import { createPaymentGateway } from './payment'
import { checkRate } from './rate-limit'
import { resolveBool, resolveConfigValues, resolveLlmReady, resolvePositiveInt, resolveSetting, yuanToFen } from './settings'

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

  // 额度与奖励配置：读一次、传下去，避免同一函数里多处现读造成口径漂移。
  // 用 resolvePositiveInt 而非裸 Number：脏值（如 .env 里的 `abc`）会被播种入库，
  // 裸 Number 得 NaN 会把 NaN 绑进额度与流水（见 settings.ts 里该函数的注释）。
  const inviteEnabled = resolveBool(store, process.env, 'INVITE_REWARD_ENABLED', false)
  const signupBonus = resolvePositiveInt(store, process.env, 'SIGNUP_BONUS_CREDITS', DEFAULT_SIGNUP_BONUS_CREDITS)

  // ⚠️ 邀请关系的**唯一裁决点**：关闭时不解析邀请码，故 invitedBy 恒为 null，
  // 后续 recordInvite 根本不会被调用 —— 不把「是否发奖励」再散落到别处判一次。
  let invitedBy: string | null = null
  if (inviteEnabled && input.inviteCode && input.inviteCode.trim()) {
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
  store.addCredits(user.id, signupBonus, { source: 'signup_bonus', note: '注册赠送' })

  if (invitedBy) {
    const inviter = store.getUserById(invitedBy)!
    const reward = inviteRewardFor(inviter.invitedCount, {
      credits: resolvePositiveInt(store, process.env, 'INVITE_REWARD_CREDITS', DEFAULT_INVITE_REWARD_CREDITS),
      maxInvitees: resolvePositiveInt(store, process.env, 'INVITE_REWARD_MAX_INVITEES', DEFAULT_INVITE_REWARD_MAX_INVITEES),
    })
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

  // 参考图两源分流：refu_ = 暂存参考（生成时转正为画布图），cimg_ = 已在画布的图
  const stagedIds: string[] = []
  const canvasRefIds: string[] = []
  for (const id of Array.isArray(input.referenceCanvasImageIds) ? input.referenceCanvasImageIds : []) {
    if (id.startsWith('refu_')) stagedIds.push(id)
    else canvasRefIds.push(id)
  }
  // 上限兜底（客户端已按张准入，这里防绕过）：必须在扣费之前，否则超限会先扣额度再失败
  const refCountError = validateReferenceCount(stagedIds.length + canvasRefIds.length)
  if (refCountError) throw new ServiceError(400, refCountError)
  // 画布参考：校验归属（必须存在、属于当前用户与当前任务）
  for (const id of canvasRefIds) {
    const img = store.getCanvasImage(id)
    if (!img || img.userId !== user.id || img.topicId !== topic.id) {
      throw new ServiceError(400, '参考图不存在或不属于当前任务。')
    }
  }

  const cost = input.count
  // refId 留空：扣费发生在 createMessage 之前，此刻还没有消息 id（把扣费挪后又会改变
  // 「额度不足时不建 topic/message」的既有语义）
  const updated = store.deductCredits(user.id, cost, { source: 'generation_charge', refId: null, note: '入队扣费' })
  if (!updated) throw new ServiceError(402, '额度不足，请先充值。')

  // 扣费成功后才把暂存参考转正为画布图：画布只在生成真正发生时被触及。
  // ⚠️ 转正会抛（参考图已被别处删掉等）：钱已经扣了、消息还没建，worker 不会替我们退 ——
  // 这里必须自己退，否则用户「没出图却掉了额度」。
  let stagedCanvasIds: string[]
  try {
    stagedCanvasIds = await resolveStagedReferences(store, dataDir, user, topic.id, stagedIds)
  } catch (e) {
    store.addCredits(user.id, cost, { source: 'generation_refund', refId: null, note: '参考图转正失败退额' })
    throw e
  }
  const validRefs = [...canvasRefIds, ...stagedCanvasIds]

  const size = sizeCheck.value

  // 提示词增强：**服务端权威**——前端传 enhance 只是意愿，这里再 AND 一次配置（双保险）。
  // 失败一律降级为原文：增强是可选增益，不该让生成失败，也不该动额度（额度按张预扣，与本段无关）。
  // 每轮现构造客户端（不缓存）：配置可在管理后台热改，缓存会让「改了 LLM 密钥、页面显示成功、
  // 实际仍打旧网关」静默失效 —— 与 provider / worker 的处理一致。
  const basePrompt = input.prompt.trim()
  let finalPrompt = basePrompt
  let enhanced = false
  if (input.enhance && resolveLlmReady(store, process.env)) {
    try {
      const out = await createLlmFromConfig(resolveConfigValues(store, process.env)).enhance(basePrompt)
      if (out.trim()) {
        finalPrompt = out.trim()
        enhanced = true
      }
    } catch (e) {
      console.error('[motif] 提示词增强失败，降级为原文:', e)
    }
  }

  const message = store.createMessage({
    topicId: topic.id,
    userId: user.id,
    prompt: basePrompt,
    finalPrompt,
    size,
    requestedCount: input.count,
    // 记「真的增强过」而不是「用户请求了增强」：后者会让事后对账分不清到底调没调 LLM
    enhancePrompt: enhanced,
    referenceIds: validRefs,
  })
  store.setTopicActive(topic.id, message.id, basePrompt, 'pending')

  return {
    prompt: basePrompt,
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
    // 双读：本地优先、本地没有才问远端 —— 切到 s3 后老参考图仍能参与生成
    const storage = resolveStorage(dataDir)
    const remote = resolveRemoteStorage(dataDir)
    const referenceImages = (
      await Promise.all(
        (msg.referenceIds ?? []).map(async (id) => {
          const meta = store.getCanvasImage(id)
          if (!meta) return null
          try {
            return { buffer: await readImageWithFallback(storage, remote, meta.imageKey), mimeType: meta.mimeType }
          } catch {
            return null // 参考图文件缺失时降级为纯文生图
          }
        })
      )
    ).filter((x): x is { buffer: Buffer; mimeType: string } => x !== null)

    // 断点续跑：崩溃重排后从已生成数继续，只补剩余张数（额度守恒，防超发）
    const alreadyDone = store.countGeneratedInMessage(messageId)
    // 落位上下文：新产出落进「当前视口内的空位槽」。视口以 topics.canvas_meta 为准
    // （服务端唯一能读到的「用户当前看到的区域」），故生成的图不会堆在 (0,0)。
    const placementOrigin = viewportOrigin(store.getCanvasMeta(msg.topicId).viewport)
    const occupied = store.listCanvasPlacements(msg.topicId).map(placementRect)
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
      await storage.write(imageKey, img.buffer)
      // 位置列与图片行在**同一条 INSERT** 落库：不存在「有图无位置」的中间态。
      // ⚠️ 不要拆成「先插图、再 UPDATE 位置」两步。
      const size = displaySize(img.width, img.height)
      const [slot] = allocateSlots(occupied, [size], placementOrigin)
      occupied.push(slot)
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
        placement: { x: slot.x, y: slot.y, width: slot.w, height: slot.h },
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

// ---------- 参考图上传（暂存制：不入画布，开始生成时转正） ----------

export async function saveReferenceImage(
  store: MotifStore,
  dataDir: string,
  user: User,
  topicId: string,
  file: { buffer: Buffer; mimeType: string; name?: string }
): Promise<StagedReference> {
  const topic = store.getTopic(topicId)
  if (!topic || topic.userId !== user.id) throw new ServiceError(404, '任务不存在。')
  const ext = file.mimeType.includes('png') ? 'png' : file.mimeType.includes('webp') ? 'webp' : 'jpg'
  const imageKey = buildImageKey(user.id, topicId, null, `${randomUUID()}.${ext}`)
  await resolveStorage(dataDir).write(imageKey, file.buffer)
  // 只进暂存表，不写 canvas_images：画布保持空态（模板画廊可见），开始生成时才转正
  return store.insertReferenceUpload({
    topicId,
    userId: user.id,
    name: (file.name || '参考图').slice(0, 40),
    imageKey,
    mimeType: file.mimeType,
    bytes: file.buffer.length,
  })
}

/**
 * 读原图像素尺寸；失败一律回退 0（调用方走 `displaySize(0,0)` 的正方形兜底）。
 * 转正不能因为读图失败而失败，所以这里吞掉所有异常。
 */
async function readImageSize(source: string | Buffer): Promise<{ width: number; height: number }> {
  try {
    // sharp 既接受路径也接受 Buffer：远端（s3）没有本地路径，只能喂字节
    const meta = await sharp(source).metadata()
    const w = meta.width ?? 0
    const h = meta.height ?? 0
    return w > 0 && h > 0 ? { width: w, height: h } : { width: 0, height: 0 }
  } catch {
    return { width: 0, height: 0 }
  }
}

/**
 * 暂存参考转正：把 refu_ 暂存图逐张落为画布图（origin=uploaded），返回可用的画布参考 id 列表。
 * 归属校验失败（不存在/非本人/非本任务）直接抛错，绝不静默跳过。
 *
 * ⚠️ **两遍走**（先全校验、再全落库），不是单遍边校边写：
 * 单遍在第 k 张失败时会留下前 k-1 张**已转正**的画布图（且暂存记录已删），调用方却只看到抛错 ——
 * 钱退了、消息没建，画布上却凭空多出几张图。分两遍后校验期零副作用，失败即整体不生效。
 */
export async function resolveStagedReferences(
  store: MotifStore,
  dataDir: string,
  user: User,
  topicId: string,
  stagedIds: string[]
): Promise<string[]> {
  // 第一遍：只读校验 + 并发读尺寸（尺寸读取互不依赖，串行等 IO 是白等；参考图上限 5 张，无资源压力）
  const refs = stagedIds.map((id) => {
    const ref = store.getReferenceUpload(id)
    if (!ref || ref.topicId !== topicId) throw new ServiceError(400, '参考图不存在或不属于当前任务。')
    return ref
  })
  // 读真实像素尺寸再分配槽位：写死 0 会让渲染按原图比例、模型按 240 方形，两边对不上
  const storage = resolveStorage(dataDir)
  const remote = resolveRemoteStorage(dataDir)
  const sizes = await Promise.all(refs.map(async (r) => readImageSize(await readImageWithFallback(storage, remote, r.imageKey))))

  // 第二遍：落库。走到这里校验已全过，不会再抛
  // 落位上下文：转正的参考图也进「当前视口内的空位槽」，与生成产出共用同一套分配规则
  const origin = viewportOrigin(store.getCanvasMeta(topicId).viewport)
  const occupied = store.listCanvasPlacements(topicId).map(placementRect)
  const out: string[] = []
  refs.forEach((ref, i) => {
    const size = sizes[i]
    const [slot] = allocateSlots(occupied, [displaySize(size.width, size.height)], origin)
    occupied.push(slot)
    const img = store.insertCanvasImage({
      topicId,
      userId: user.id,
      messageId: null,
      origin: 'uploaded',
      name: ref.name,
      imageKey: ref.imageKey,
      mimeType: ref.mimeType,
      bytes: ref.bytes,
      width: size.width,
      height: size.height,
      placement: { x: slot.x, y: slot.y, width: slot.w, height: slot.h },
    })
    store.deleteReferenceUpload(ref.id)
    out.push(img.id)
  })
  return out
}

/** 删除暂存参考（上传后反悔用）：校验归属 */
export function removeStagedReference(store: MotifStore, user: User, id: string): void {
  const ref = store.getReferenceUpload(id)
  if (!ref) return // 已不存在视为已删除（幂等）
  const topic = store.getTopic(ref.topicId)
  if (!topic || topic.userId !== user.id) throw new ServiceError(404, '参考图不存在。')
  store.deleteReferenceUpload(id)
}

// ---------- billing / redeem ----------

const PACKAGE_FALLBACK: ReadonlyArray<{ credits: number; fen: number }> = [
  { credits: 50, fen: 6800 },
  { credits: 100, fen: 13600 },
  { credits: 200, fen: 27200 },
  { credits: 500, fen: 68000 },
]

/**
 * 套餐：币种与价格后台可配（settings 唯一真相），缺省回退 68/136/272/680。
 * amountTotal 一律「分」；清空配置键 = 删除行 → 回退默认（与 settings 清空语义一致）。
 */
export function resolvePackages(store: MotifStore, env: Record<string, string | undefined>): CreditPackage[] {
  // 归一小写：Stripe 要求小写 ISO 币种，播种绕过校验的大写值在这里兜住
  const currency = (resolveSetting(store, env, 'BILLING_CURRENCY') ?? 'hkd').toLowerCase()
  return PACKAGE_FALLBACK.map(({ credits, fen }) => {
    const key = `PRICE_CREDITS_${credits}`
    const raw = resolveSetting(store, env, key)
    const parsed = raw !== null ? yuanToFen(raw) : null
    if (raw !== null && parsed === null) {
      // 直改库/播种可绕过 money 校验：坏值静默回退会让运营无信号，这里留一条日志
      console.warn(`[billing] ${key} 配置非法（${raw}），已回退默认价`)
    }
    return { id: `credits_${credits}`, label: `${credits} 张额度`, credits, amountTotal: parsed ?? fen, currency }
  })
}

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
 * 支付渠道：mock（模拟收银台，默认）| epay | stripe。
 * PAYMENT_CHANNEL 是危险区合一开关：选真实渠道即「正式计费」。
 * 安全基线：非 mock 渠道下，模拟支付端点一律 403，防止公开部署被「免费印钞」。
 * 未知值兜底 mock（fail-safe），与 configHealth 探测的归一化一致。
 */
export function paymentChannel(store: MotifStore): 'mock' | 'epay' | 'stripe' {
  const raw = (resolveSetting(store, process.env, 'PAYMENT_CHANNEL') ?? 'mock').toLowerCase()
  return raw === 'epay' || raw === 'stripe' ? raw : 'mock'
}

export interface CheckoutStart {
  orderId: string
  checkoutUrl: string
}

const CHECKOUT_UNAVAILABLE = '支付渠道暂不可用，请稍后再试；问题持续请联系站点管理员。'

/**
 * 下单分流：mock → 站内收银台；epay/stripe → 网关收银页。
 * 订单先落 pending（记录创建渠道）；渠道配置错误/网关异常统一转用户友好 503
 * （内部键名走 payment 健康检查与审计，不透给充值用户）。
 * 渠道切换不影响已建订单：notify/webhook 路由按各自 URL 定渠道、用当前凭据现构造网关，
 * 行为上对存量订单的回调依然友好（但凭据被替换后旧单回调会验签失败，换密钥需留意在途订单）。
 */
export async function startCheckout(store: MotifStore, env: Record<string, string | undefined>, userId: string, packageId: string): Promise<CheckoutStart> {
  const pkg = resolvePackages(store, env).find((p) => p.id === packageId)
  if (!pkg) throw new ServiceError(400, '套餐不存在。')
  const channel = paymentChannel(store)
  const orderId = store.createOrder(userId, pkg, channel)
  if (channel === 'mock') return { orderId, checkoutUrl: `/billing/mock-pay?order=${orderId}` }
  try {
    const site = resolveSetting(store, env, 'SITE_URL')
    if (!site) throw new ServiceError(503, CHECKOUT_UNAVAILABLE)
    const base = site.replace(/\/+$/, '')
    const gateway = createPaymentGateway(channel, resolveConfigValues(store, env))
    const { redirectUrl } = await gateway.createCheckout(
      { orderId, label: pkg.label, amountTotal: pkg.amountTotal, currency: pkg.currency },
      {
        notifyUrl: `${base}/api/billing/notify/epay`,
        returnUrl: `${base}/billing/result?order=${orderId}`,
        cancelUrl: `${base}/billing/result?order=${orderId}&canceled=1`,
      }
    )
    return { orderId, checkoutUrl: redirectUrl }
  } catch (e) {
    if (e instanceof ServiceError) throw e
    throw new ServiceError(503, CHECKOUT_UNAVAILABLE)
  }
}

/**
 * 回调入账：金额核对（分对分）→ payOrder 条件更新（pending→paid 仅一次）→ addCredits。
 * ok=入账；duplicate=重复通知（幂等忽略）；mismatch=金额不符（拒绝）；
 * not_found=订单不可见（异常时序），区别于 duplicate——调用方回 fail 让网关按策略重试，防真实付款丢单。
 */
export function creditPaidOrder(store: MotifStore, orderId: string, paidFen: number): 'ok' | 'duplicate' | 'mismatch' | 'not_found' {
  const order = store.getOrder(orderId)
  if (!order) return 'not_found'
  if (order.status !== 'pending') return 'duplicate'
  if (order.amountTotal !== paidFen) return 'mismatch'
  const credits = store.payOrder(orderId, order.userId)
  if (credits === null) return 'duplicate' // 并发下另一通知抢先入账
  store.addCredits(order.userId, credits, { source: 'order_paid', refId: orderId, note: '订单支付到账' })
  return 'ok'
}
