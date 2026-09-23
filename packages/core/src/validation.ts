/** 输入校验 —— 纯函数，服务端与客户端共用 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const SIZE_RE = /^(\d{2,5})x(\d{2,5})$/

export function validateEmail(email: string): string | null {
  if (!email || !EMAIL_RE.test(email)) return '请输入有效的邮箱地址。'
  return null
}

/**
 * 密码复杂度规则（设计 D14 / #74-2.1）：长度 ≥8，且同时含小写字母、大写字母、数字与符号。
 *
 * ⚠️ 只用于**新设**密码（注册 / 改密 / 重置），不在登录时校验 ——
 * 否则规则一收紧，存量账号会被自己的密码锁在门外。
 *
 * 规则文案的**唯一来源**：既当报错文案，又给界面明示规则用（注册页与改密弹窗共用一份），
 * 避免「界面写的规则」与「校验实际拦的规则」两处各写一遍后悄悄分叉。
 */
export const PASSWORD_RULE_TEXT = '密码至少 8 位，且需同时包含大写字母、小写字母、数字和符号。'

export function validatePassword(password: string): string | null {
  // 长度与复杂度合并成一条文案：用户看到的就是完整规则，不必「改一处报一处」试出来。
  // 长度阈值（8）直接内联：它只在本函数用一次，对外暴露的规则入口是上面的 PASSWORD_RULE_TEXT。
  if (!password || password.length < 8) return PASSWORD_RULE_TEXT
  const complexEnough =
    /[a-z]/.test(password) && /[A-Z]/.test(password) && /[0-9]/.test(password) && /[^A-Za-z0-9]/.test(password)
  if (!complexEnough) return PASSWORD_RULE_TEXT
  return null
}

/**
 * 两次输入是否一致（注册的「密码 + 确认密码」）。
 *
 * 放进 core 而不是各调用点手写，是为了让**客户端先行校验**与**服务端兜底校验**用的是同一句文案：
 * 两处各写一遍时，改一处漏一处会让同一种错误出现两种说法。
 */
export function validatePasswordConfirm(password: string, passwordConfirm: string): string | null {
  if (password !== passwordConfirm) return '两次输入的密码不一致。'
  return null
}

export function validateName(name: string): string | null {
  if (!name || !name.trim()) return '请输入昵称。'
  if (name.trim().length > 40) return '昵称过长。'
  return null
}

export function validateVerificationCode(code: string): string | null {
  if (!code || !/^\d{6}$/.test(code)) return '验证码应为 6 位数字。'
  return null
}

export function validatePrompt(prompt: string): string | null {
  if (!prompt || !prompt.trim()) return '请输入提示词。'
  if (prompt.length > 4000) return '提示词过长（上限 4000 字）。'
  return null
}

export function validateCount(count: number): string | null {
  if (!Number.isInteger(count) || count < 1 || count > 12) return '张数需在 1–12 之间。'
  return null
}

export const ALLOWED_SIZES = ['1024x1024', '1024x1536', '1536x1024'] as const

/** size 允许：预设尺寸 / auto / 自定义 WxH（256–2048） */
export function validateSize(size: string): { ok: true; value: string } | { ok: false; error: string } {
  if (size === 'auto') return { ok: true, value: 'auto' }
  const m = SIZE_RE.exec(size)
  if (!m) return { ok: false, error: '尺寸格式应为 宽x高，如 1024x1024。' }
  const w = Number(m[1])
  const h = Number(m[2])
  if (w < 256 || w > 2048 || h < 256 || h > 2048) {
    return { ok: false, error: '宽高需在 256–2048 像素之间。' }
  }
  return { ok: true, value: `${w}x${h}` }
}

/** auto 解析为方图 */
export function resolveSize(size: string): { width: number; height: number } {
  if (size === 'auto') return { width: 1024, height: 1024 }
  const m = SIZE_RE.exec(size)
  if (!m) return { width: 1024, height: 1024 }
  return { width: Number(m[1]), height: Number(m[2]) }
}

/** 图片魔数检测：不信任客户端声明的 Content-Type */
export function detectImageMime(buf: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (!buf || buf.length < 12) return null
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  return null
}
