import { describe, expect, it } from 'vitest'
import { MAILER_GUIDES, PAYMENT_GUIDES_EMPTY_OK } from '@/lib/guide-cards'

describe('邮件渠道引导卡数据', () => {
  it('smtp/resend/sendgrid 三渠道各有一张卡', () => {
    for (const ch of ['smtp', 'resend', 'sendgrid'] as const) {
      expect(MAILER_GUIDES[ch].length).toBeGreaterThanOrEqual(1)
    }
  })

  it('每张卡：标题、≥2 步指引、https 入口链接', () => {
    for (const cards of Object.values(MAILER_GUIDES)) {
      for (const c of cards) {
        expect(c.title.length).toBeGreaterThan(0)
        expect(c.steps.length).toBeGreaterThanOrEqual(2)
        expect(c.linkUrl.startsWith('https://')).toBe(true)
        expect(c.linkLabel.length).toBeGreaterThan(0)
      }
    }
  })
})
