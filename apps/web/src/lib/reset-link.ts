/**
 * 找回密码邮件里「直达链接」的参数解析（issue #21）。
 *
 * 链接形态：`${SITE_URL}/?reset=1&email=<urlencoded>&code=<6 位码>`
 * 落地行为：打开落地页并**自动弹出重置弹窗、预填邮箱与验证码**，用户只需输新密码。
 *
 * 抽成纯函数是为了把「什么算合法深链」钉在单测里 —— 组件里只留一行调用。
 *
 * ⚠️ **预填只是便利，不是鉴权**：这里不做任何「凭码放行」的判断，真正的校验始终在
 * `POST /api/auth/password-reset` 里按库中验证码进行。所以本函数**宁可返回 null**（退化为
 * 手工输入）也不预填一个不可能合法的值 —— 预填垃圾只会让用户提交后收到「验证码无效」而不知为何。
 */
export interface ResetPrefill {
  email: string
  code: string
}

/** 与 AuthModal 同口径的邮箱形状判据（宽松：只挡明显不是邮箱的输入） */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** 验证码形状：`newVerificationCode()` 恒为 6 位数字 */
const CODE_RE = /^\d{6}$/

/**
 * 从 query 参数解析出预填值。
 *
 * 取值表由调用方用 `Object.fromEntries(URLSearchParams)` 构造，故同名参数出现多次时
 * **取最后一个**（`Object.fromEntries` 的既定行为）；这里不做多值处理 ——
 * 深链由 `buildResetLink` 生成，本来就不会有重复参数。
 *
 * @param sp 形如 `{ reset, email, code }` 的取值表（缺项为 `undefined`）
 * @returns 合法时返回预填值；否则 `null`（调用方什么都不做，用户照旧手工输入）
 */
export function parseResetParams(sp: Record<string, string | undefined>): ResetPrefill | null {
  const one = (v: string | undefined): string => (v ?? '').trim()

  if (one(sp.reset) !== '1') return null
  const email = one(sp.email)
  const code = one(sp.code)
  if (!EMAIL_RE.test(email)) return null
  if (!CODE_RE.test(code)) return null
  return { email, code }
}
