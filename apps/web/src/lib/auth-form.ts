/**
 * 认证弹窗（AuthModal）里的**纯逻辑**：先行校验、必填判定、视图切换时的字段清理。
 *
 * 为什么单独成文件：这三件事都不碰 React / DOM，却直接决定「点提交后有没有反馈」（#80-1.1）
 * 与「密码会不会被带进另一个视图」（#80-1.2）。留在 .tsx 里就只能靠浏览器手测；
 * 抽到这里即可在 node 环境下单测（apps/web 的 vitest 是 environment: 'node'，不引入 jsdom）。
 */

import { validateEmail, validatePassword, validatePasswordConfirm, validateVerificationCode } from '@motif/core'

/** 弹窗的三种视图（当前值由 Landing 持有） */
export type AuthMode = 'login' | 'register' | 'reset'

/** 表单字段快照（三种视图共用同一批 state） */
export interface AuthFields {
  name: string
  email: string
  code: string
  password: string
  passwordConfirm: string
}

/** 切视图时要一并处理的**全部**字段：表单字段 + 入口上下文邀请码 + 注册准入码（后两者都不是 `AuthFields` 的成员） */
export interface AuthFieldState extends AuthFields {
  inviteCode: string
  /** 注册准入码：**不是**推荐用的邀请码（见 CONTEXT.md），只在注册视图出现 */
  registrationCode: string
}

/**
 * 客户端**先行**校验：返回第一条错误文案，全部通过返回 null（#74-2.2 必填 / #74-2.1 密码规则 / #80-1.1 内联报错）。
 *
 * 为什么必须在发请求之前做：
 * 1) 这些错误原本要等一个来回才由服务端返回；注册表单较长、报错落在对话框底部，用户很容易误判成「点了没反应」；
 * 2) 服务端文案是**兜底**，不是唯一的反馈渠道 —— 邮箱格式、密码规则、两次一致这三条与 core 共用同一份判据，
 *    不会出现两侧口径分叉。
 *
 * ⚠️ **验证码这一条两侧用的是同一份判据**：服务端 `register` 也走 core 的 `validateVerificationCode`
 * （`/^\d{6}$/`，必须是 6 位数字）—— 早先服务端那条是内联 `/^.{6}$/`（只判长度、客户端更严），
 * 已在本轮一并收紧，故此处不再有「哪边更严」的分叉。
 *
 * 顺序刻意与用户填写顺序一致（必填 → 格式 → 规则 → 两次一致），一次只报一条，改一个填一个。
 */
/**
 * 注册视图的先行校验。
 *
 * 邮箱验证码是否**必填**由两件事共同决定（与服务端 `register` 的判据同源）：
 * - `requireEmailCode`：后台开关 `REGISTRATION_REQUIRE_EMAIL_CODE`；
 * - `hasAccessCode`：用户填了**注册准入码** —— 码本身就是凭据，验证码整行都不需要。
 *
 * ⚠️ 少了 `hasAccessCode` 这一支，「带准入码 + 不填验证码」会被这里先拦死（提交按钮还是灰的），
 *    服务端那条准入码路径就永远走不到 —— 功能在界面上不可达。
 */
function registerAuthError(f: AuthFields, opts: { requireEmailCode: boolean; hasAccessCode: boolean }): string | null {
  const needCode = opts.requireEmailCode && !opts.hasAccessCode
  if (!f.name.trim()) return '请输入昵称。'
  if (!f.email.trim()) return '请输入邮箱。'
  if (needCode && !f.code.trim()) return '请输入 6 位邮箱验证码。'
  if (!f.password) return '请输入密码。'
  if (!f.passwordConfirm) return '请再次输入密码。'
  const emailErr = validateEmail(f.email)
  if (emailErr) return emailErr
  if (needCode) {
    const codeErr = validateVerificationCode(f.code)
    if (codeErr) return codeErr
  }
  const pwdErr = validatePassword(f.password)
  if (pwdErr) return pwdErr
  return validatePasswordConfirm(f.password, f.passwordConfirm)
}

/** 找回密码视图的先行校验。⚠️ 验证码**始终必填** —— 注册那个开关与它无关。 */
function resetAuthError(f: AuthFields): string | null {
  if (!f.email.trim()) return '请输入邮箱。'
  if (!f.code.trim()) return '请输入 6 位邮箱验证码。'
  if (!f.password) return '请输入新密码。'
  const emailErr = validateEmail(f.email)
  if (emailErr) return emailErr
  const codeErr = validateVerificationCode(f.code)
  if (codeErr) return codeErr
  return validatePassword(f.password)
}

export function clientAuthError(
  mode: AuthMode,
  f: AuthFields,
  opts: { requireEmailCode?: boolean; hasAccessCode?: boolean } = {},
): string | null {
  if (mode === 'register') {
    return registerAuthError(f, {
      requireEmailCode: opts.requireEmailCode ?? true,
      hasAccessCode: opts.hasAccessCode ?? false,
    })
  }
  if (mode === 'reset') return resetAuthError(f)
  // 登录：只拦空值 —— 邮箱格式错误与凭据错误都归服务端统一口径（「邮箱或密码不正确。」），
  // 免得客户端把「账号不存在」与「邮箱写错」说成两句不同的话，反而泄露账号是否存在。
  if (!f.email.trim()) return '请输入邮箱。'
  if (!f.password) return '请输入密码。'
  return null
}

/**
 * 必填是否齐全（只判「非空」，不判格式与规则）—— 用于提交按钮置灰。
 * 与 clientAuthError 分工：空表单直接不让点（#74-2.2），格式/规则类错误点下去就地报（能说清为什么）。
 *
 * ⚠️ 两个 opts 与 clientAuthError 同源同判据（`hasAccessCode` 见 registerAuthError 的说明）：
 *    这里漏一支，按钮就永远是灰的 —— 报错文案再准也点不下去。
 */
export function isFormFilled(
  mode: AuthMode,
  f: AuthFields,
  opts: { requireEmailCode?: boolean; hasAccessCode?: boolean } = {},
): boolean {
  if (mode === 'register') {
    // ⚠️ 两个开关只作用于注册；reset 走下面那行，验证码始终必填（opts 对它无效）。
    const requireCode = opts.requireEmailCode ?? true
    const needCode = requireCode && !(opts.hasAccessCode ?? false)
    return Boolean(f.name.trim() && f.email.trim() && f.password && f.passwordConfirm && (!needCode || f.code.trim()))
  }
  if (mode === 'reset') return Boolean(f.email.trim() && f.code.trim() && f.password)
  return Boolean(f.email.trim() && f.password)
}

/**
 * 视图切换时的字段清理（#80-1.2）：输入旧视图的字段值，输出新视图应持有的字段值。
 *
 * 清理规则与目标视图**无关** —— 三种视图的清空集合完全一致，故本函数**不接收**目标视图：
 * 早先版本带过一个 `next: AuthMode` 参数，函数体里只 `void next`（死参数），签名会让人误以为
 * 「清空集合随视图变化」，已按 YAGNI 删除。将来真出现按视图差异化时再加，且要带上单测。
 *
 * - **清空**密码类字段（登录密码 / 新密码 / 注册密码与确认密码）：否则登录密码会被带进「找回密码」的
 *   新密码框（掩码可见），用户不留意就会把密码重置回同一个旧值；注册侧更直接 —— 密码被带入旧值、
 *   用户只补「确认密码」时极易触发「两次输入的密码不一致」。
 * - **清空**昵称与验证码：视图私有字段（且注册与重置的验证码用途不同，不可复用）。
 * - **保留**邮箱：三种视图都要用，是用户输入成本最高的一项。
 * - **保留**邀请码：它来自邀请链接（`?invite=`），属于**入口上下文**而不是视图字段 ——
 *   清掉会让被邀请人切一次视图就静默丢掉奖励。
 * - **保留**注册准入码：同属**入口上下文**（用户从管理端拿到的一次性凭据，多为粘贴输入），
 *   且只在注册视图提交 —— 带着它切走不会泄漏到别的视图，清掉却要用户重贴一次。
 */
export function switchAuthFields(prev: AuthFieldState): AuthFieldState {
  return {
    name: '',
    email: prev.email,
    code: '',
    password: '',
    passwordConfirm: '',
    inviteCode: prev.inviteCode,
    registrationCode: prev.registrationCode,
  }
}
