import type { MotifStore } from '@motif/db'
import { createImageProviderFromEnv } from '@motif/image-provider'
import { createMailerFromConfig } from './mailer'
import { createLlmFromConfig } from './llm'
import { createStorageFromConfig } from './storage'
import { createPaymentGateway } from './payment'

/**
 * 配置注册表与存取策略。
 *
 * 三条不变量：
 * 1. 只有本文件知道「有哪些键」。别处一律通过 resolveConfigValues / readSettingsView 取值。
 * 2. 本文件**不 import ./context 与 ./services** —— 前者会形成循环（context 要读配置），
 *    后者的 ServiceError 会形成循环（services 要读危险区开关）。校验失败以返回值表达，不抛异常。
 * 3. 只读键（数据位置）永不进 DB：它们决定数据库自身位置，属于先于数据库存在的引导参数。
 */

/**
 * 设置页的分组。`prompts` 是**动作面板**（提示词源状态 + 「立即刷新」），
 * `SETTING_DEFS` 里没有它的键 —— 它照样是一个分区，只是不承载配置。
 */
export type SettingGroup = 'generation' | 'credits' | 'payment' | 'mailer' | 'llm' | 'storage' | 'prompts' | 'danger' | 'security' | 'data'
export type SettingKind = 'string' | 'number' | 'boolean' | 'enum' | 'secret' | 'url' | 'money'

export interface SettingDef {
  key: string
  group: SettingGroup
  label: string
  kind: SettingKind
  /** 该键为空时实际生效的兜底，**仅用于展示** —— 真正的兜底在各构造器里 */
  defaultHint?: string
  /** 该键为空的后果 / 填写提示；为空表示可选 */
  hint?: string
  /** 仅 enum 用 */
  options?: readonly string[]
  /** 值为空即拒绝保存 */
  required?: boolean
  /** 决定数据库位置，只能在环境变量里改 */
  readOnly?: boolean
  /** 会削弱安全基线，必须走专用入口 + 二次确认 */
  danger?: boolean
  /** 改了它需要重建 provider / mailer */
  affectsRuntime?: boolean
}

export const SETTING_DEFS: readonly SettingDef[] = [
  // ---- 生图网关 ----
  { key: 'IMAGE_API_BASE_URL', group: 'generation', label: '网关地址', kind: 'url', required: true, affectsRuntime: true, hint: 'OpenAI 兼容网关的根地址，例如 https://api.example.com/v1' },
  { key: 'IMAGE_API_KEY', group: 'generation', label: 'API 密钥', kind: 'secret', required: true, affectsRuntime: true, hint: '只写不读：保存后页面只显示掩码' },
  { key: 'IMAGE_MODEL', group: 'generation', label: '模型', kind: 'string', defaultHint: 'gpt-image-2', affectsRuntime: true },
  // 关闭后本进程不再跑队列，改由独立进程 `pnpm worker` 接管（两者可共存，租约保证不双跑）。
  // ⚠️ 刻意**不是** affectsRuntime：它不涉及 provider/mailer 重建，需重启进程才生效（hint 写明）。
  { key: 'MOTIF_INPROC_WORKER', group: 'generation', label: '本进程内运行生成队列 worker', kind: 'boolean', defaultHint: 'true', hint: '关闭后需另跑 `pnpm worker` 独立进程接管出图，否则队列无人消费。改动后需重启服务生效。' },

  // ---- 额度与奖励 ----
  // 分组名取 credits 而非 invite：注册赠送不属于邀请活动，放 invite 组语义不对。
  // 四项一律非 danger：它们只决定发放多少，不削弱安全基线。
  // ⚠️ 邀请活动**默认关闭**：改动前奖励是默认生效的，故未配置新键的现有部署升级后会失去邀请奖励
  //    （入口隐藏、不再发奖）。这是需求明确接受的口径，升级须知写在对应 PR 描述里。
  { key: 'INVITE_REWARD_ENABLED', group: 'credits', label: '邀请好友送额度', kind: 'boolean', defaultHint: 'false', hint: '关闭后工作台不再显示邀请入口，且注册时不再建立邀请关系、不发奖励。' },
  { key: 'INVITE_REWARD_CREDITS', group: 'credits', label: '每邀请 1 人赠送额度', kind: 'number', defaultHint: '3', hint: '单位：张。仅在活动开启时生效。' },
  { key: 'INVITE_REWARD_MAX_INVITEES', group: 'credits', label: '最多奖励人数', kind: 'number', defaultHint: '3', hint: '超过此人数后继续邀请不再发放奖励，但邀请关系仍建立。' },
  { key: 'SIGNUP_BONUS_CREDITS', group: 'credits', label: '注册赠送额度', kind: 'number', defaultHint: '3', hint: '单位：张。与邀请活动开关无关：关闭邀请活动不影响注册赠送。' },

  // ---- 邮件发信 ----
  { key: 'MOTIF_MAILER', group: 'mailer', label: '发信渠道', kind: 'enum', options: ['console', 'smtp', 'resend', 'sendgrid'], defaultHint: 'console', affectsRuntime: true, hint: 'console 只把验证码打进服务端日志，用于本地联调' },
  { key: 'MAIL_FROM', group: 'mailer', label: '发件人地址', kind: 'string', affectsRuntime: true, hint: '真实渠道必填' },
  { key: 'SMTP_HOST', group: 'mailer', label: 'SMTP 主机', kind: 'string', affectsRuntime: true },
  { key: 'SMTP_PORT', group: 'mailer', label: 'SMTP 端口', kind: 'number', affectsRuntime: true, hint: 'QQ 邮箱为 465' },
  { key: 'SMTP_SECURE', group: 'mailer', label: 'SMTP 加密', kind: 'boolean', affectsRuntime: true, hint: '留空则按端口是否为 465 自动判断' },
  { key: 'SMTP_USER', group: 'mailer', label: 'SMTP 用户名', kind: 'string', affectsRuntime: true },
  { key: 'SMTP_PASS', group: 'mailer', label: 'SMTP 密码 / 授权码', kind: 'secret', affectsRuntime: true, hint: '只写不读' },
  { key: 'RESEND_API_KEY', group: 'mailer', label: 'Resend 密钥', kind: 'secret', affectsRuntime: true, hint: '只写不读' },
  { key: 'SENDGRID_API_KEY', group: 'mailer', label: 'SendGrid 密钥', kind: 'secret', affectsRuntime: true, hint: '只写不读' },

  // ---- 提示词增强（独立 LLM） ----
  // 独立于生图网关：增强走 chat/completions、生图走 images，两者域名与密钥通常不同（D12）。
  // 端点与密钥**必填**：开关开着但没配齐时 configHealth 判未就绪，生成链路按「不增强」走。
  { key: 'LLM_ENHANCE_ENABLED', group: 'llm', label: '启用提示词增强', kind: 'boolean', defaultHint: 'false', hint: '开启后生成前会先调 LLM 改写提示词；需同时配好端点与密钥才真正生效。' },
  { key: 'LLM_API_BASE_URL', group: 'llm', label: 'LLM 接口地址', kind: 'url', required: true, hint: 'OpenAI 兼容的 chat/completions 根地址，例如 https://api.example.com/v1' },
  { key: 'LLM_API_KEY', group: 'llm', label: 'LLM 密钥', kind: 'secret', required: true, hint: '只写不读：保存后页面只显示掩码' },
  { key: 'LLM_MODEL', group: 'llm', label: '增强模型', kind: 'string', defaultHint: 'gpt-4o-mini' },
  { key: 'LLM_TIMEOUT_MS', group: 'llm', label: '增强超时（毫秒）', kind: 'number', defaultHint: '20000', hint: '增强失败不阻断生成，超时只是让降级更快发生。' },

  // ---- 图片存储 ----
  // 驱动为 local 时全部 S3_* 隐藏（见 lib/setting-visibility.ts）。
  // 切到 s3 后新图写远端；本地已有的老图仍可读（双读），可用 `pnpm storage:migrate` 搬迁。
  { key: 'STORAGE_DRIVER', group: 'storage', label: '图片存储驱动', kind: 'enum', options: ['local', 's3'], defaultHint: 'local', hint: '切到 s3 后新图写远端；本地已有的老图仍可读（双读），可用 `pnpm storage:migrate` 搬迁。' },
  { key: 'S3_ENDPOINT', group: 'storage', label: 'S3 端点', kind: 'url', required: true, hint: '含协议，例如 https://s3.example.com（自建 MinIO 也填这里）' },
  { key: 'S3_REGION', group: 'storage', label: '区域', kind: 'string', defaultHint: 'us-east-1', hint: '多数自建服务不校验，可留空使用默认。' },
  { key: 'S3_BUCKET', group: 'storage', label: '存储桶', kind: 'string', required: true },
  { key: 'S3_ACCESS_KEY_ID', group: 'storage', label: 'Access Key ID', kind: 'string', required: true },
  { key: 'S3_SECRET_ACCESS_KEY', group: 'storage', label: 'Secret Access Key', kind: 'secret', required: true, hint: '只写不读：保存后页面只显示掩码' },
  { key: 'S3_FORCE_PATH_STYLE', group: 'storage', label: '强制 path-style 寻址', kind: 'boolean', defaultHint: 'false', hint: '自建 MinIO / 无 DNS 泛解析的兼容服务需开启。' },

  // ---- 支付与套餐 ----
  // 支付键一律不带 affectsRuntime：checkout / notify 每次请求都用 resolveConfigValues 现读现构造，
  // 不进 runtime 缓存，保存即热生效，无需重建 provider / mailer。
  { key: 'SITE_URL', group: 'payment', label: '站点地址', kind: 'url', hint: '如 https://motif.example.com；支付回调与支付完成跳转由此拼接，真实渠道必填' },
  { key: 'BILLING_CURRENCY', group: 'payment', label: '套餐币种', kind: 'enum', options: ['cny', 'usd', 'hkd', 'eur', 'gbp'], defaultHint: 'hkd', hint: '全局单币种，不含零小数货币（jpy 会与按分计价冲突放大 100 倍金额）；易支付网关基本仅支持 cny' },
  { key: 'PRICE_CREDITS_50', group: 'payment', label: '50 张价格（所选币种）', kind: 'money', defaultHint: '68.00', hint: '单位跟随套餐币种主单位；两位小数、单档 ≤99999.99；需高于渠道最低收款额（Stripe 按币种 USD0.50/HKD4.00…，易支付站点常见 ≥1 元）；下单按分落库' },
  { key: 'PRICE_CREDITS_100', group: 'payment', label: '100 张价格（所选币种）', kind: 'money', defaultHint: '136.00' },
  { key: 'PRICE_CREDITS_200', group: 'payment', label: '200 张价格（所选币种）', kind: 'money', defaultHint: '272.00' },
  { key: 'PRICE_CREDITS_500', group: 'payment', label: '500 张价格（所选币种）', kind: 'money', defaultHint: '680.00' },
  { key: 'EPAY_API_URL', group: 'payment', label: '易支付网关地址', kind: 'url', hint: '易支付协议网关根地址，选 epay 渠道必填' },
  { key: 'EPAY_PID', group: 'payment', label: '易支付商户 ID', kind: 'string' },
  { key: 'EPAY_KEY', group: 'payment', label: '易支付商户密钥', kind: 'secret', hint: '只写不读' },
  { key: 'STRIPE_SECRET_KEY', group: 'payment', label: 'Stripe 密钥', kind: 'secret', hint: 'sk_test_… / sk_live_…；只写不读' },
  { key: 'STRIPE_WEBHOOK_SECRET', group: 'payment', label: 'Stripe Webhook 签名密钥', kind: 'secret', hint: 'whsec_…（test 模式在 Dashboard /test/webhooks 获取）；只写不读' },

  // ---- 危险区：会削弱安全基线，必须走专用入口 + 二次确认 ----
  { key: 'MOTIF_EXPOSE_DEV_CODE', group: 'danger', label: '验证码随接口直出', kind: 'boolean', defaultHint: 'false', danger: true, hint: '开启后任何人调注册接口都能直接拿到验证码，等于关闭邮箱验证。仅限本地联调。' },
  { key: 'PAYMENT_CHANNEL', group: 'danger', label: '支付渠道', kind: 'enum', options: ['mock', 'epay', 'stripe'], defaultHint: 'mock', danger: true, hint: 'mock=模拟收银台（不产生真实扣款）；epay/stripe=真实渠道，需先在「支付与套餐」保存对应凭据，否则用户无法充值。切回 mock 时存量真实渠道订单仍按创建渠道回调入账。' },

  // ---- 会话与安全 ----
  { key: 'MOTIF_COOKIE_SECURE', group: 'security', label: '会话 Cookie 加 Secure 标记', kind: 'boolean', defaultHint: 'false', hint: 'HTTPS 部署时开启；本地 http 联调勿开，否则浏览器会拒收 cookie。' },

  // ---- 只读：决定数据库自身位置，入库会导致「改设置去找另一个库」----
  // defaultHint 在这里不是「兜底值」而是「没设时实际会落在哪」：只读项常常是空的（默认路径
  // 由应用自己拼），页面若只显示空输入框，运维会以为「没配置」而不知道数据到底在哪。
  { key: 'MOTIF_DATA_DIR', group: 'data', label: '数据目录', kind: 'string', readOnly: true, defaultHint: 'apps/web/.data', hint: '决定数据库位置，属于先于数据库存在的引导参数，只能在环境变量里修改。未设置时用相对应用工作目录的 .data。' },
  { key: 'MOTIF_DB_FILE', group: 'data', label: '数据库文件', kind: 'string', readOnly: true, defaultHint: '<数据目录>/motif.db', hint: '同上。未设置时用数据目录下的 motif.db。' },
]

const BY_KEY = new Map(SETTING_DEFS.map((d) => [d.key, d]))

/** 取一项配置：DB 优先，回退 env；都没有返回 null（不是空串）。只读键恒取 env。 */
export function resolveSetting(store: MotifStore, env: Record<string, string | undefined>, key: string): string | null {
  const def = BY_KEY.get(key)
  if (!def?.readOnly) {
    const fromDb = store.getSetting(key)
    if (fromDb !== null) return fromDb
  }
  const fromEnv = env[key]
  return fromEnv === undefined ? null : fromEnv
}

/**
 * 把注册表里的键解析成一张取值表，形状与 env 相同 ——
 * 这样既有的 createImageProviderFromEnv / createMailerFromConfig 一行都不用改就能吃 DB 的值。
 */
export function resolveConfigValues(
  store: MotifStore,
  env: Record<string, string | undefined>
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const def of SETTING_DEFS) {
    out[def.key] = resolveSetting(store, env, def.key) ?? undefined
  }
  return out
}

/** 读一个布尔开关（'1' / 'true' 为真），DB 优先、回退 env、最后回退 fallback */
export function resolveBool(
  store: MotifStore,
  env: Record<string, string | undefined>,
  key: string,
  fallback = false
): boolean {
  const raw = resolveSetting(store, env, key)
  if (raw === null || raw === '') return fallback
  return raw === '1' || raw.toLowerCase() === 'true'
}

/**
 * 读一个正整数配置（DB 优先、回退 env、最后回退 fallback）。
 *
 * ⚠️ **不要用裸 `Number(value ?? fallback)`**：`??` 只兜 null / undefined，**兜不住 NaN** ——
 * 而 `seedSettings` 把 env 值**不经校验**地播种入库（只跳过空值），所以 `.env` 里写
 * `SIGNUP_BONUS_CREDITS=abc` 会被原样存进库，裸 Number 得 NaN，进而把 NaN 绑进
 * `credits = credits + ?` 与 `credit_ledger.delta`，污染额度守恒。
 */
export function resolvePositiveInt(
  store: MotifStore,
  env: Record<string, string | undefined>,
  key: string,
  fallback: number
): number {
  const raw = resolveSetting(store, env, key)
  if (raw === null || raw === '') return fallback
  const n = Number(raw)
  return Number.isInteger(n) && n >= 1 ? n : fallback
}

/**
 * 密钥掩码：保留前 3 与后 4 字符。
 * 8 位及以内**全部遮蔽** —— 否则「前 3 + 后 4」就等于把短密钥原样回显。
 */
export function maskSecret(value: string): string {
  if (!value) return ''
  if (value.length <= 8) return '•'.repeat(value.length)
  return `${value.slice(0, 3)}${'•'.repeat(Math.min(12, value.length - 7))}${value.slice(-4)}`
}

/** 元字符串 → 分整数；非法/超上限返回 null。金额一律以分存储与比对，避免浮点。 */
export function yuanToFen(v: string): number | null {
  if (!/^\d{1,5}(\.\d{1,2})?$/.test(v)) return null
  return Math.round(Number(v) * 100)
}

/**
 * 播种：只把 env 里**非空**的值写进 DB，已存在的键一律不动。返回本次新写入的键。
 *
 * 不播空值的理由：播一个空串会把「未设置」伪装成「已设置」，还会让 env 回退被永久遮蔽 ——
 * 之后运维在 .env 里补上值再重启也读不到，因为 DB 里已经有一条空记录了。
 */
export function seedSettings(store: MotifStore, env: Record<string, string | undefined>): string[] {
  const seeded: string[] = []
  for (const def of SETTING_DEFS) {
    if (def.readOnly) continue
    const value = env[def.key]
    if (value === undefined || value === '') continue
    if (store.seedSetting(def.key, value)) seeded.push(def.key)
  }
  return seeded
}

export interface SettingView {
  key: string
  group: SettingGroup
  label: string
  kind: SettingKind
  /** 非密钥项的可读值；密钥项**恒为 null** */
  value: string | null
  /** 密钥项的掩码；非密钥项恒为 null */
  masked: string | null
  isSet: boolean
  source: 'db' | 'env' | 'unset'
  readOnly: boolean
  danger: boolean
  options: readonly string[] | null
  defaultHint: string | null
  hint: string | null
}

/** 读取视图。密钥项一律不返回明文 —— 这条由本函数独占负责，别处不得再拼装密钥输出。 */
export function readSettingsView(store: MotifStore, env: Record<string, string | undefined>): SettingView[] {
  return SETTING_DEFS.map((def) => {
    const fromDb = def.readOnly ? null : store.getSetting(def.key)
    const raw = fromDb ?? env[def.key] ?? null
    const isSecret = def.kind === 'secret'
    const source: SettingView['source'] = fromDb !== null ? 'db' : raw ? 'env' : 'unset'
    return {
      key: def.key,
      group: def.group,
      label: def.label,
      kind: def.kind,
      value: isSecret ? null : raw,
      masked: isSecret && raw ? maskSecret(raw) : null,
      isSet: !!raw,
      source,
      readOnly: !!def.readOnly,
      danger: !!def.danger,
      options: def.options ?? null,
      defaultHint: def.defaultHint ?? null,
      hint: def.hint ?? null,
    }
  })
}

export type WriteResult = { ok: true; updated: string[]; runtimeAffected: boolean } | { ok: false; error: string }

function validateValue(def: SettingDef, value: string): string | null {
  if (!value.trim()) return def.required ? `${def.label}（${def.key}）不能为空。` : null
  switch (def.kind) {
    case 'url': {
      let parsed: URL
      try {
        parsed = new URL(value)
      } catch {
        return `${def.label}（${def.key}）不是合法 URL。`
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return `${def.label}（${def.key}）必须是 http(s) 地址。`
      }
      return null
    }
    case 'number':
      return Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 65535
        ? null
        : `${def.label}（${def.key}）需为 1–65535 的整数。`
    case 'boolean':
      // 文案必须列全实际接受的取值：这里接受四个（`resolveBool` 也认 1/0），
      // 只写「true 或 false」会让运营以为 `1` 是非法输入
      return ['true', 'false', '1', '0'].includes(value.toLowerCase())
        ? null
        : `${def.label}（${def.key}）只能是 true / false / 1 / 0。`
    case 'enum':
      return def.options?.includes(value) ? null : `${def.label}（${def.key}）只能是 ${def.options?.join(' / ')}。`
    case 'money':
      // 上限防误配超大值：转分后超出安全整数 / SQLite 整数边界会让下单整链路 500
      return /^\d{1,5}(\.\d{1,2})?$/.test(value)
        ? null
        : `${def.label}（${def.key}）需为 0–99999.99 的数字，最多两位小数。`
    default:
      return null
  }
}

/**
 * 写入配置。**先全量校验再落库** —— 避免「一半写进去、一半被拒」这种最难解释的状态。
 *
 * `danger` 由调用方按入口传：普通入口 false、危险区入口 true。注册表里 danger 标记与它不符即拒，
 * 于是「危险区开关混进普通批量保存」在数据层就不可能发生，而不是靠页面自觉。
 *
 * 两处刻意的非对称语义：
 * 1. **非字符串值直接拒绝**（而不是 `String(v)` 强转）。请求体来自 JSON，`{"SMTP_PORT":465}`
 *    传成数字是极常见的写法；强转会悄悄把 465 写成 "465" 而让人以为「我明明传了数字也能存」，
 *    拒绝则立刻暴露「配置项的值一律按字符串处理」这条规则。
 * 2. **非必填键的「清空」是删除该行，不是写入空串**。写空串会让 resolveSetting 永远返回 ''，
 *    把 env 回退永久遮蔽，还会让读取视图报出 source: 'db' 配 isSet: false 这种自相矛盾的一对。
 *    删除之后 source / isSet / value 三者自然一致。
 */
export function writeSettings(
  store: MotifStore,
  updates: Record<string, string>,
  opts: { danger: boolean }
): WriteResult {
  const keys = Object.keys(updates)
  if (keys.length === 0) return { ok: false, error: '没有需要保存的配置项。' }

  const defs: SettingDef[] = []
  const toDelete = new Set<string>()
  for (const key of keys) {
    const def = BY_KEY.get(key)
    if (!def) return { ok: false, error: `未知配置项：${key}。` }
    if (def.readOnly) {
      return { ok: false, error: `${def.label}（${key}）决定数据库自身的位置，属于引导参数，只能在环境变量里修改。` }
    }
    if (!!def.danger !== opts.danger) {
      return {
        ok: false,
        error: opts.danger
          ? `${def.label}（${key}）不是危险区开关，请走普通配置保存。`
          : `${def.label}（${key}）属危险区开关，请使用危险区入口并二次确认。`,
      }
    }
    const value = updates[key]
    if (typeof value !== 'string') return { ok: false, error: `${def.label}（${key}）的值必须是字符串。` }
    const err = validateValue(def, value)
    if (err) return { ok: false, error: err }
    defs.push(def)
    if (value.trim() === '') toDelete.add(key)
  }

  const writes = defs.filter((d) => !toDelete.has(d.key)).map((d) => ({ key: d.key, value: updates[d.key] }))
  if (writes.length > 0) store.setSettings(writes)
  if (toDelete.size > 0) store.deleteSettings([...toDelete])
  // ⚠️ 用 defs 而不是 writes 算：清空一个键（= 删除）同样改变配置来源，也需要重建运行时
  return { ok: true, updated: keys, runtimeAffected: defs.some((d) => d.affectsRuntime) }
}

export interface ConfigHealth {
  group: SettingGroup
  ready: boolean
  reason: string | null
}

/**
 * 配置健康检查。**判据直接复用构造器**（在 try/catch 里真的构造一次），
 * 不另写一份「必需字段清单」—— 那样两份清单必然漂移，页面说就绪、实际构造却抛错。
 */
export function configHealth(store: MotifStore, env: Record<string, string | undefined>): ConfigHealth[] {
  const values = resolveConfigValues(store, env)
  const probe = (group: SettingGroup, build: () => unknown): ConfigHealth => {
    try {
      build()
      return { group, ready: true, reason: null }
    } catch (e) {
      return { group, ready: false, reason: e instanceof Error ? e.message : String(e) }
    }
  }
  return [
    probe('generation', () => createImageProviderFromEnv(values)),
    probe('mailer', () => createMailerFromConfig(values)),
    probe('payment', () => {
      // 判据复用 createPaymentGateway 工厂（必需字段清单不手写第二份，防漂移）；
      // 对 stripe 额外要求 webhook 密钥——工厂能构造但收不到合法回调，运营上必须视为未就绪
      const channel = (values.PAYMENT_CHANNEL ?? 'mock').toLowerCase()
      if (channel === 'mock') return null
      if (channel !== 'epay' && channel !== 'stripe') return null
      createPaymentGateway(channel, values)
      if (channel === 'stripe' && !values.STRIPE_WEBHOOK_SECRET) {
        throw new Error('Stripe 渠道还需配置 Webhook 签名密钥（whsec_…），否则支付回调无法验签入账')
      }
      return null
    }),
    // 判据复用 createLlmFromConfig（必需字段清单不手写第二份）。
    // ⚠️ 开关关闭时**不算未就绪**：未启用是运营的选择，不是配置缺失 —— 否则页面会一直挂一个假告警。
    // 判据复用 createStorageFromConfig（必需字段清单不手写第二份）。
    // dataDir 传 cwd 即可：local 分支不用它，s3 分支也不用它（只做配置校验，不建连接）。
    probe('storage', () => createStorageFromConfig(values, process.cwd())),
    probe('llm', () => {
      if (!resolveBool(store, env, 'LLM_ENHANCE_ENABLED', false)) return null
      createLlmFromConfig(values)
      return null
    }),
  ]
}

/**
 * 提示词增强是否真的可用：开关开 **且** 配置齐备。
 *
 * 服务端权威判定 —— 前端传 `enhance: true` 只是意愿，生成链路在这里再 AND 一次（双保险）：
 * 前端被绕过或版本不一致时，服务端仍不会去调未配置的 LLM。
 */
export function resolveLlmReady(store: MotifStore, env: Record<string, string | undefined>): boolean {
  if (!resolveBool(store, env, 'LLM_ENHANCE_ENABLED', false)) return false
  try {
    createLlmFromConfig(resolveConfigValues(store, env))
    return true
  } catch {
    return false
  }
}
