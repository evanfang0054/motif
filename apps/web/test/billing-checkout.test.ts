import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MotifStore } from '@motif/db'
import { ServiceError, startCheckout } from '@/server/services'

let dir: string
let store: MotifStore
let userId: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'motif-co-'))
  store = new MotifStore(join(dir, 't.db'))
  userId = store.createUser({ name: 'u', email: 'u@e.com', passwordHash: 'x', role: 'user' }).id
  // 充值开关默认**关**（自建部署的默认形态），所以下面每条「能下单」的用例都得先打开它。
  // 关着的形态由第一条用例单独钉住 —— 那才是默认口径。
  store.setSetting('BILLING_ENABLED', 'true')
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('startCheckout（mock 渠道）', () => {
  it('充值开关关闭（默认）→ 403，且不建单', async () => {
    store.setSetting('BILLING_ENABLED', 'false')
    await expect(startCheckout(store, {}, userId, 'credits_50')).rejects.toThrow('本站未开放充值。')
    expect(store.listOrders({ userId })).toHaveLength(0)
  })
  it('返回站内收银台链接并创建 mock 渠道 pending 订单', async () => {
    const r = await startCheckout(store, {}, userId, 'credits_50')
    expect(r.checkoutUrl).toContain('/billing/mock-pay?order=')
    expect(r.orderId).toBeTruthy()
    expect(store.getOrder(r.orderId)).toMatchObject({ channel: 'mock', status: 'pending', amountTotal: 6800 })
  })
  it('套餐不存在 → 400', async () => {
    await expect(startCheckout(store, {}, userId, 'nope')).rejects.toThrow(ServiceError)
  })
  it('真实渠道缺 SITE_URL → 用户友好 503（不透内部键名）', async () => {
    store.setSettings([
      { key: 'PAYMENT_CHANNEL', value: 'epay' },
      { key: 'EPAY_API_URL', value: 'https://p.x' },
      { key: 'EPAY_PID', value: '1' },
      { key: 'EPAY_KEY', value: 'k' },
    ])
    await expect(startCheckout(store, {}, userId, 'credits_50')).rejects.toThrow(/暂不可用/)
  })
  it('网关配置错误同样转 503 文案（不透 EPAY_* 键名）', async () => {
    store.setSettings([{ key: 'PAYMENT_CHANNEL', value: 'epay' }]) // 三件套缺失
    await expect(startCheckout(store, {}, userId, 'credits_50')).rejects.toThrow(/暂不可用/)
  })
  it('epay 渠道配置齐全：返回网关收银页 URL（含 submit.php 与签名订单号）', async () => {
    store.setSettings([
      { key: 'PAYMENT_CHANNEL', value: 'epay' },
      { key: 'EPAY_API_URL', value: 'https://p.x' },
      { key: 'EPAY_PID', value: '1' },
      { key: 'EPAY_KEY', value: 'k' },
      { key: 'SITE_URL', value: 'https://m.example.com' },
    ])
    const r = await startCheckout(store, {}, userId, 'credits_50')
    expect(r.checkoutUrl).toContain('https://p.x/submit.php')
    expect(r.checkoutUrl).toContain(`out_trade_no=${r.orderId}`)
    expect(store.getOrder(r.orderId)).toMatchObject({ channel: 'epay' })
  })
})
