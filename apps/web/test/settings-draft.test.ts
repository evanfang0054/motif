import { describe, expect, it } from 'vitest'
import { enumOptionItems, pickUpdates } from '@/lib/settings-draft'
import type { AdminSettingItem } from '@/lib/client'

function item(partial: Partial<AdminSettingItem> & Pick<AdminSettingItem, 'key'>): AdminSettingItem {
  return {
    group: 'payment',
    label: partial.key,
    kind: 'enum',
    value: null,
    masked: null,
    isSet: false,
    source: 'unset',
    readOnly: false,
    danger: false,
    options: null,
    defaultHint: null,
    hint: null,
    ...partial,
  }
}

describe('enumOptionItems', () => {
  // 回归护栏：曾把 id 写成 `opt-<key>-<value>`，HeroUI Select 以 id 为值，
  // 于是回传 `opt-BILLING_CURRENCY-cny` 被后端 enum 校验拒掉 ——
  // 用户选的就是提示里列出的合法值，却报「只能是 cny / usd / …」。
  it('id 恒等于裸枚举值，不带任何前缀', () => {
    expect(enumOptionItems(['cny', 'usd'])).toEqual([
      { id: 'cny', label: 'cny' },
      { id: 'usd', label: 'usd' },
    ])
  })

  it('每个 id 都必须是入参里的原值', () => {
    const options = ['console', 'smtp', 'resend', 'sendgrid']
    for (const o of enumOptionItems(options)) expect(options).toContain(o.id)
  })

  it('入参为 null 时返回空数组', () => {
    expect(enumOptionItems(null)).toEqual([])
  })
})

describe('pickUpdates', () => {
  const items: AdminSettingItem[] = [
    item({ key: 'MOTIF_MAILER', group: 'mailer', value: 'console', options: ['console', 'smtp'] }),
    item({ key: 'SMTP_HOST', group: 'mailer', kind: 'string' }),
    item({ key: 'MAIL_FROM', group: 'mailer', kind: 'string' }),
    item({ key: 'BILLING_CURRENCY', group: 'payment', value: 'hkd', options: ['cny', 'hkd'] }),
  ]

  it('只挑本组的键，别的组的脏值不混入', () => {
    const updates = pickUpdates({
      items,
      dirty: { BILLING_CURRENCY: 'cny', SMTP_HOST: 'smtp.example.com' },
      group: 'payment',
    })
    expect(updates).toEqual({ BILLING_CURRENCY: 'cny' })
  })

  it('原样透传草稿值 —— 值语义由 UI 侧保证为裸枚举值', () => {
    const updates = pickUpdates({ items, dirty: { BILLING_CURRENCY: 'cny' }, group: 'payment' })
    expect(updates.BILLING_CURRENCY).toBe('cny')
    expect(updates.BILLING_CURRENCY).not.toMatch(/^opt-/)
  })

  it('渠道切到 console 时，隐藏的 smtp 凭据字段即使有脏值也不提交', () => {
    const updates = pickUpdates({
      items,
      dirty: { MOTIF_MAILER: 'console', SMTP_HOST: 'smtp.example.com' },
      group: 'mailer',
    })
    expect(updates).toEqual({ MOTIF_MAILER: 'console' })
  })

  it('渠道切到 smtp 时，凭据字段的脏值应被提交', () => {
    const updates = pickUpdates({
      items,
      dirty: { MOTIF_MAILER: 'smtp', SMTP_HOST: 'smtp.example.com' },
      group: 'mailer',
    })
    expect(updates).toEqual({ MOTIF_MAILER: 'smtp', SMTP_HOST: 'smtp.example.com' })
  })

  it('未保存的渠道草稿值优先于库中已存值来裁决显隐', () => {
    // 库里是 console，草稿改成 smtp：应按 smtp 判可见
    const updates = pickUpdates({
      items,
      dirty: { MOTIF_MAILER: 'smtp', SMTP_HOST: 'smtp.example.com' },
      group: 'mailer',
    })
    expect(Object.keys(updates)).toContain('SMTP_HOST')
  })
})
