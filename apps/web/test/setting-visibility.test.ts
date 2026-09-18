import { describe, expect, it } from 'vitest'
import { mailerFieldVisible } from '@/lib/setting-visibility'

const item = (key: string) => ({ key })

describe('mailer 字段按渠道显隐', () => {
  it('smtp 渠道显示 SMTP_* 但不显示 resend/sendgrid 密钥', () => {
    expect(mailerFieldVisible(item('SMTP_HOST'), 'smtp')).toBe(true)
    expect(mailerFieldVisible(item('SMTP_PASS'), 'smtp')).toBe(true)
    expect(mailerFieldVisible(item('RESEND_API_KEY'), 'smtp')).toBe(false)
    expect(mailerFieldVisible(item('SENDGRID_API_KEY'), 'smtp')).toBe(false)
  })

  it('resend 渠道只显示发件人 + Resend 密钥', () => {
    expect(mailerFieldVisible(item('MAIL_FROM'), 'resend')).toBe(true)
    expect(mailerFieldVisible(item('RESEND_API_KEY'), 'resend')).toBe(true)
    expect(mailerFieldVisible(item('SMTP_USER'), 'resend')).toBe(false)
  })

  it('console 渠道隐藏全部凭据字段；空值视为 console', () => {
    expect(mailerFieldVisible(item('MAIL_FROM'), 'console')).toBe(false)
    expect(mailerFieldVisible(item('MAIL_FROM'), null)).toBe(false)
  })

  it('非 mailer 组的键一律不受影响', () => {
    expect(mailerFieldVisible(item('IMAGE_API_KEY'), 'console')).toBe(true)
    expect(mailerFieldVisible(item('IMAGE_API_KEY'), 'smtp')).toBe(true)
  })
})
