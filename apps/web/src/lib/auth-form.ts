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

/** 切视图时要一并处理的**全部**字段：表单字段 + 入口上下文邀请码（邀请码不在表单里） */
export interface AuthFieldState extends AuthFields {
  inviteCode: string
}

/**
 * 客户端**先行**校验：返回第一条错误文案，全部通过返回 null（#74-2.2 必填 / #74-2.1 密码规则 / #80-1.1 内联报错）。
 *
 * 为什么必须在发请求之前做：
 * 1) 这些错误原本要等一个来回才由服务端返回；注册表单较长、报错落在对话框底部，用户很容易误判成「点了没反应」；
 * 2) 服务端文案是**兜底**，不是唯一的反馈渠道 —— 邮箱格式、密码规则、两次一致这三条与 core 共用同一份判据，
 *    不会出现两侧口径分叉。
 *
 * ⚠️ **验证码是唯一的例外**：服务端用的是内联 `/^.{6}$/`（只判长度，见 `server/services.ts` 的 `register`），
 * 这里用 core 的 `validateVerificationCode`（`/^\d{6}$/`，必须是 6 位数字）—— 即客户端**更严**，
 * 只会拦下服务端也会拒的输入，不会放过服务端会拒的。收紧服务端那条是另一件事，此处不做。
 *
 * 顺序刻意与用户填写顺序一致（必填 → 格式 → 规则 → 两次一致），一次只报一条，改一个填一个。
 */
export function clientAuthError(mode: AuthMode, f: AuthFields): string | null {
  if (mode === 'register') {
    if (!f.name.trim()) return '请输入昵称。'
    if (!f.email.trim()) return '请输入邮箱。'
    if (!f.code.trim()) return '请输入 6 位邮箱验证码。'
    if (!f.password) return '请输入密码。'
    if (!f.passwordConfirm) return '请再次输入密码。'
    const emailErr = validateEmail(f.email)
    if (emailErr) return emailErr
    const codeErr = validateVerificationCode(f.code)
    if (codeErr) return codeErr
    const pwdErr = validatePassword(f.password)
    if (pwdErr) return pwdErr
    return validatePasswordConfirm(f.password, f.passwordConfirm)
  }
  if (mode === 'reset') {
    if (!f.email.trim()) return '请输入邮箱。'
    if (!f.code.trim()) return '请输入 6 位邮箱验证码。'
    if (!f.password) return '请输入新密码。'
    const emailErr = validateEmail(f.email)
    if (emailErr) return emailErr
    const codeErr = validateVerificationCode(f.code)
    if (codeErr) return codeErr
    return validatePassword(f.password)
  }
  // 登录：只拦空值 —— 邮箱格式错误与凭据错误都归服务端统一口径（「邮箱或密码不正确。」），
  // 免得客户端把「账号不存在」与「邮箱写错」说成两句不同的话，反而泄露账号是否存在。
  if (!f.email.trim()) return '请输入邮箱。'
  if (!f.password) return '请输入密码。'
  return null
}

/**
 * 必填是否齐全（只判「非空」，不判格式与规则）—— 用于提交按钮置灰。
 * 与 clientAuthError 分工：空表单直接不让点（#74-2.2），格式/规则类错误点下去就地报（能说清为什么）。
 */
export function isFormFilled(mode: AuthMode, f: AuthFields): boolean {
  if (mode === 'register') {
    return Boolean(f.name.trim() && f.email.trim() && f.code.trim() && f.password && f.passwordConfirm)
  }
  if (mode === 'reset') return Boolean(f.email.trim() && f.code.trim() && f.password)
  return Boolean(f.email.trim() && f.password)
}

/**
 * 视图切换时的字段清理（#80-1.2）：输入旧视图的字段值 + 新视图，输出新视图应持有的字段值。
 *
 * 清理规则与目标视图**无关**（`next` 参与签名只为让调用点自解释「这是新视图的字段状态」，
 * 并为将来按视图差异化留位 —— 当前三种视图的清空集合完全一致）：
 * - **清空**密码类字段（登录密码 / 新密码 / 注册密码与确认密码）：否则登录密码会被带进「找回密码」的
 *   新密码框（掩码可见），用户不留意就会把密码重置回同一个旧值；注册侧更直接 —— 密码被带入旧值、
 *   用户只补「确认密码」时极易触发「两次输入的密码不一致」。
 * - **清空**昵称与验证码：视图私有字段（且注册与重置的验证码用途不同，不可复用）。
 * - **保留**邮箱：三种视图都要用，是用户输入成本最高的一项。
 * - **保留**邀请码：它来自邀请链接（`?invite=`），属于**入口上下文**而不是视图字段 ——
 *   清掉会让被邀请人切一次视图就静默丢掉奖励。
 */
export function switchAuthFields(prev: AuthFieldState, next: AuthMode): AuthFieldState {
  void next
  return {
    name: '',
    email: prev.email,
    code: '',
    password: '',
    passwordConfirm: '',
    inviteCode: prev.inviteCode,
  }
}
