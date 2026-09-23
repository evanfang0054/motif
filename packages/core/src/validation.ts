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

/** 提示词长度上限：界面的字数计数器与 `validatePrompt` 共用一份，避免两处各写一遍后悄悄分叉 */
export const PROMPT_MAX_LEN = 4000

export function validatePrompt(prompt: string): string | null {
  if (!prompt || !prompt.trim()) return '请输入提示词。'
  if (prompt.length > PROMPT_MAX_LEN) return `提示词过长（上限 ${PROMPT_MAX_LEN} 字）。`
  return null
}

/** 张数的允许范围：`validateCount`、`clampCount` 与界面标注共用一份 */
export const COUNT_MIN = 1
export const COUNT_MAX = 12

export function validateCount(count: number): string | null {
  if (!Number.isInteger(count) || count < COUNT_MIN || count > COUNT_MAX) return `张数需在 ${COUNT_MIN}–${COUNT_MAX} 之间。`
  return null
}

/**
 * 张数输入的归一：**先四舍五入、再钳制**。
 *
 * 顺序不可颠倒：先钳后舍会把 12.6 舍成 13（越界），先舍后钳才是 12。
 * 抽到 core 是因为「输入框失焦写回」与「提交前兜底」必须用同一套判据，
 * 否则界面显示的张数与真正提交的张数可能不是同一个数。
 */
export function clampCount(value: number): number {
  if (!Number.isFinite(value)) return COUNT_MIN
  return Math.min(COUNT_MAX, Math.max(COUNT_MIN, Math.round(value)))
}

export const ALLOWED_SIZES = ['1024x1024', '1024x1536', '1536x1024'] as const

/** 自定义宽高的像素范围（与 `validateSize` 一致） */
export const SIZE_MIN = 256
export const SIZE_MAX = 2048

/**
 * 三档吸附比例，源自 `ALLOWED_SIZES`：1024x1024=1:1、1024x1536=2:3、1536x1024=3:2。
 * 抽成表是为了让「选最近一档」与「按档推另一边」共用同一份定义。
 */
export const SIZE_RATIOS = [
  { key: '1:1', w: 1, h: 1 },
  { key: '2:3', w: 2, h: 3 },
  { key: '3:2', w: 3, h: 2 },
] as const

export interface SnappedSize {
  width: number
  height: number
  /** 最终尺寸实际命中的比例档；钳制导致比例偏离时返回 null（不谎报比例） */
  ratio: string | null
}

const clampSize = (n: number) => Math.min(SIZE_MAX, Math.max(SIZE_MIN, Math.round(n)))

/** 实际宽高比命中的预设档；容差 1%（四舍五入会让比例有细微偏差） */
function achievedRatio(width: number, height: number): string | null {
  const r = width / height
  let best: string | null = null
  let bestDiff = Infinity
  for (const p of SIZE_RATIOS) {
    const diff = Math.abs(r - p.w / p.h)
    if (diff < bestDiff) {
      bestDiff = diff
      best = p.key
    }
  }
  return bestDiff <= 0.01 ? best : null
}

/**
 * 自定义尺寸吸附（#83-1.2）：**保留正在编辑的那一边**，用当前宽高比在三档里取最接近的一档，
 * 再按该比例推另一边。
 *
 * 为什么保留编辑边而不是直接落到最近预设像素：用户输入的是「我要多宽」，
 * 把宽直接改成 1024 是更大的意外；保住编辑边、只推另一边，符合意图且可预期。
 *
 * 顺序：选档 → 推另一边（四舍五入）→ **两边各自钳进 [256,2048]**。
 * 钳制会让极端尺寸的实际比例偏离预设（如宽 2048 时 2:3 的高会被压到 2048），
 * 此时 `ratio` 返回 null，界面只回显最终尺寸。
 */
export function snapCustomSize(edited: 'w' | 'h', width: number, height: number): SnappedSize {
  const w0 = Number.isFinite(width) && width > 0 ? width : SIZE_MIN
  const h0 = Number.isFinite(height) && height > 0 ? height : SIZE_MIN
  const current = w0 / h0
  // 最近档：用宽高比的绝对差最小者（比例而非像素距离 —— 像素距离会偏向大尺寸）
  let target: (typeof SIZE_RATIOS)[number] = SIZE_RATIOS[0]
  let bestDiff = Infinity
  for (const p of SIZE_RATIOS) {
    const diff = Math.abs(current - p.w / p.h)
    if (diff < bestDiff) {
      bestDiff = diff
      target = p
    }
  }
  const ratioNum = target.w / target.h
  let outW: number
  let outH: number
  if (edited === 'w') {
    outW = clampSize(w0)
    outH = clampSize(outW / ratioNum)
  } else {
    outH = clampSize(h0)
    outW = clampSize(outH * ratioNum)
  }
  return { width: outW, height: outH, ratio: achievedRatio(outW, outH) }
}

/** size 允许：预设尺寸 / auto / 自定义 WxH（256–2048） */
export function validateSize(size: string): { ok: true; value: string } | { ok: false; error: string } {
  if (size === 'auto') return { ok: true, value: 'auto' }
  const m = SIZE_RE.exec(size)
  if (!m) return { ok: false, error: '尺寸格式应为 宽x高，如 1024x1024。' }
  const w = Number(m[1])
  const h = Number(m[2])
  if (w < SIZE_MIN || w > SIZE_MAX || h < SIZE_MIN || h > SIZE_MAX) {
    return { ok: false, error: `宽高需在 ${SIZE_MIN}–${SIZE_MAX} 像素之间。` }
  }
  return { ok: true, value: `${w}x${h}` }
}

/**
 * 任务重命名校验：与服务端 `PATCH /api/topics/[id]` 的唯一规则（trim 后非空）对齐。
 * 服务端没有长度上限，这里也不擅自加 —— 客户端拦得比服务端严会让「界面说不行、接口其实接受」。
 */
export function validateTopicTitle(title: string): string | null {
  if (!title || !title.trim()) return '请输入任务名称。'
  return null
}

/**
 * 会话是否已失效：401（未登录/会话过期）与 404（任务已不存在）都应**终止 watch 轮询**，
 * 否则会变成对已失效资源的无间隔请求风暴，且用户只看到「网络错误」而不知道该重新登录。
 * 抽成纯函数是为了让轮询终止判据可单测（#83-1.6 / #73-1.4 同源）。
 */
export function isSessionExpiredStatus(status: number): boolean {
  return status === 401 || status === 404
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
