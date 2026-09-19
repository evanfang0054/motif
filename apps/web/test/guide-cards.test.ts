import { describe, expect, it } from 'vitest'
import { MAILER_GUIDES, PAYMENT_GUIDES } from '@/lib/guide-cards'

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

describe('支付渠道引导卡数据', () => {
  it('epay/stripe 各有一张卡', () => {
    expect(PAYMENT_GUIDES.epay.length).toBeGreaterThanOrEqual(1)
    expect(PAYMENT_GUIDES.stripe.length).toBeGreaterThanOrEqual(1)
  })

  it('Stripe 卡必须包含 live 模式双替换步骤（防只换 key 不换 whsec 的生产事故）', () => {
    const all = PAYMENT_GUIDES.stripe.flatMap((c) => c.steps).join('\n')
    expect(all).toContain('whsec_')
    expect(all).toContain('sk_live_')
  })
})
