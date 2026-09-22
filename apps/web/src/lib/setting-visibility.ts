/** 每个发信渠道需要展示的字段；未列出的 mailer 键在任何渠道下都隐藏 */
const MAILER_FIELDS: Record<string, readonly string[]> = {
  console: [],
  smtp: ['MAIL_FROM', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS'],
  resend: ['MAIL_FROM', 'RESEND_API_KEY'],
  sendgrid: ['MAIL_FROM', 'SENDGRID_API_KEY'],
}

const MAILER_KEYS = new Set([
  'MAIL_FROM',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_SECURE',
  'SMTP_USER',
  'SMTP_PASS',
  'RESEND_API_KEY',
  'SENDGRID_API_KEY',
])

/** mailer 组显隐裁决：仅作用于 mailer 组的键；其他组的键一律返回 true */
export function mailerFieldVisible(item: { key: string }, mailerChannel: string | null): boolean {
  if (!MAILER_KEYS.has(item.key)) return true
  const allowed = MAILER_FIELDS[mailerChannel ?? 'console'] ?? []
  return allowed.includes(item.key)
}

const PAYMENT_FIELDS: Record<string, readonly string[]> = {
  mock: [],
  epay: ['EPAY_API_URL', 'EPAY_PID', 'EPAY_KEY'],
  stripe: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'],
}

/** payment 组显隐：站点地址与套餐价格恒显示；渠道凭据随传入渠道值显隐（接线传草稿优先值） */
export function paymentFieldVisible(item: { key: string }, channel: string | null): boolean {
  if (!item.key.startsWith('EPAY_') && !item.key.startsWith('STRIPE_')) return true
  const allowed = PAYMENT_FIELDS[channel ?? 'mock'] ?? []
  return allowed.includes(item.key)
}

/** storage 组显隐：驱动为 s3 时显示 S3_*，否则隐藏（null = 未设置，按 local 处理）；其他组的键一律可见 */
export function storageFieldVisible(item: { key: string }, driver: string | null): boolean {
  if (!item.key.startsWith('S3_')) return true
  return driver === 's3'
}
