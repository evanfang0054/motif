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
