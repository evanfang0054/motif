/**
 * 凭据生成：使用 Web Crypto（与 ids.ts 同一入口约定，Node 20+ 与浏览器均可用）。
 * 字符集剔除了易混淆字符（I/O/l/0/1），降低人工转录错误。
 */
const PWD_UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
const PWD_LOWER = 'abcdefghijkmnopqrstuvwxyz'
const PWD_DIGIT = '23456789'
const PWD_SYMBOL = '!@#$%^&*-_=+'
const PWD_ALL = PWD_UPPER + PWD_LOWER + PWD_DIGIT + PWD_SYMBOL

function randomIndex(max: number): number {
  const buf = new Uint8Array(1)
  globalThis.crypto.getRandomValues(buf)
  return buf[0] % max
}

/**
 * 生成强随机密码：先各取一个四类字符保证类别齐全，再用全字符集补足长度，
 * 最后 Fisher–Yates 洗牌，避免「前四位必定是 上/下/数/符」这一可预测形状。
 */
export function generateStrongPassword(length = 20): string {
  const chars: string[] = [
    PWD_UPPER[randomIndex(PWD_UPPER.length)],
    PWD_LOWER[randomIndex(PWD_LOWER.length)],
    PWD_DIGIT[randomIndex(PWD_DIGIT.length)],
    PWD_SYMBOL[randomIndex(PWD_SYMBOL.length)],
  ]
  while (chars.length < length) chars.push(PWD_ALL[randomIndex(PWD_ALL.length)])
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1)
    const t = chars[i]
    chars[i] = chars[j]
    chars[j] = t
  }
  return chars.join('')
}
