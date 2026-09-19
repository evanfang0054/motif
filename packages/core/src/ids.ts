/**
 * ID 生成：统一使用 Web Crypto（Node 20+ 与浏览器均支持），
 * 保证同一入口可安全地在客户端与服务端打包。
 */

function randomBytes(len: number): Uint8Array {
  const buf = new Uint8Array(len)
  globalThis.crypto.getRandomValues(buf)
  return buf
}

const ALPHABET = '0123456789abcdef'

function hex(len: number): string {
  const bytes = randomBytes(len)
  let out = ''
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % 16]
  return out
}

/** 实体 ID 统一为 前缀_32位hex，与公开 API 契约一致 */
export function newUserId(): string {
  return `usr_${hex(32)}`
}
export function newTopicId(): string {
  return `top_${hex(32)}`
}
export function newMessageId(): string {
  return `msg_${hex(32)}`
}
export function newCanvasImageId(): string {
  return `cimg_${hex(32)}`
}
/** 暂存参考图：上传后、生成前存在于暂存表，开始生成时转正为画布图 */
export function newReferenceUploadId(): string {
  return `refu_${hex(32)}`
}
export function newSessionToken(): string {
  return hex(64)
}
export function newOrderId(): string {
  return `ord_${hex(24)}`
}

const INVITE_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** 邀请码：10 位大写字母数字 */
export function newInviteCode(): string {
  const bytes = randomBytes(10)
  let out = ''
  for (let i = 0; i < 10; i++) out += INVITE_ALPHABET[bytes[i] % INVITE_ALPHABET.length]
  return out
}

/** 6 位数字邮箱验证码 */
export function newVerificationCode(): string {
  const bytes = randomBytes(6)
  let out = ''
  for (let i = 0; i < 6; i++) out += String(bytes[i] % 10)
  return out
}

// 剔除易混字符（I/O/L/0/1），便于人工转录与电话报码
const CDK_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'

/** CDK 码：默认 MOTIF- 前缀 + 12 位随机体 */
export function newCdkCode(prefix = 'MOTIF'): string {
  const bytes = randomBytes(12)
  let body = ''
  for (let i = 0; i < 12; i++) body += CDK_ALPHABET[bytes[i] % CDK_ALPHABET.length]
  const p = prefix.trim().toUpperCase()
  return p ? `${p}-${body}` : body
}
