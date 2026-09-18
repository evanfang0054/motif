import type { MotifStore } from '@motif/db'
import { createImageProviderFromEnv } from '@motif/image-provider'
import { createMailerFromConfig } from './mailer'

/**
 * 配置注册表与存取策略。
 *
 * 三条不变量：
 * 1. 只有本文件知道「有哪些键」。别处一律通过 resolveConfigValues / readSettingsView 取值。
 * 2. 本文件**不 import ./context 与 ./services** —— 前者会形成循环（context 要读配置），
 *    后者的 ServiceError 会形成循环（services 要读危险区开关）。校验失败以返回值表达，不抛异常。
 * 3. 只读键（数据位置）永不进 DB：它们决定数据库自身位置，属于先于数据库存在的引导参数。
 */

export type SettingGroup = 'generation' | 'mailer' | 'danger' | 'security' | 'data'
export type SettingKind = 'string' | 'number' | 'boolean' | 'enum' | 'secret' | 'url'

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

  // ---- 危险区：会削弱安全基线，必须走专用入口 + 二次确认 ----
  { key: 'MOTIF_EXPOSE_DEV_CODE', group: 'danger', label: '验证码随接口直出', kind: 'boolean', defaultHint: 'false', danger: true, hint: '开启后任何人调注册接口都能直接拿到验证码，等于关闭邮箱验证。仅限本地联调。' },
  { key: 'MOTIF_BILLING_MODE', group: 'danger', label: '计费模式', kind: 'enum', options: ['mock', 'live'], defaultHint: 'mock', danger: true, hint: '切到 live 后演示收银台端点一律拒绝，需已接入真实支付渠道，否则用户无法充值。' },

  // ---- 会话与安全 ----
  { key: 'MOTIF_COOKIE_SECURE', group: 'security', label: '会话 Cookie 加 Secure 标记', kind: 'boolean', defaultHint: 'false', hint: 'HTTPS 部署时开启；本地 http 联调勿开，否则浏览器会拒收 cookie。' },

  // ---- 只读：决定数据库自身位置，入库会导致「改设置去找另一个库」----
  { key: 'MOTIF_DATA_DIR', group: 'data', label: '数据目录', kind: 'string', readOnly: true, hint: '决定数据库位置，属于先于数据库存在的引导参数，只能在环境变量里修改。' },
  { key: 'MOTIF_DB_FILE', group: 'data', label: '数据库文件', kind: 'string', readOnly: true, hint: '同上。' },
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
 * 密钥掩码：保留前 3 与后 4 字符。
 * 8 位及以内**全部遮蔽** —— 否则「前 3 + 后 4」就等于把短密钥原样回显。
 */
export function maskSecret(value: string): string {
  if (!value) return ''
  if (value.length <= 8) return '•'.repeat(value.length)
  return `${value.slice(0, 3)}${'•'.repeat(Math.min(12, value.length - 7))}${value.slice(-4)}`
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
      return ['true', 'false', '1', '0'].includes(value.toLowerCase())
        ? null
        : `${def.label}（${def.key}）只能是 true 或 false。`
    case 'enum':
      return def.options?.includes(value) ? null : `${def.label}（${def.key}）只能是 ${def.options?.join(' / ')}。`
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
  ]
}
