import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MotifStore } from '@motif/db'
import { creditPaidOrder } from '@/server/services'

let dir: string
let store: MotifStore
let userId: string
let orderId: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'motif-credit-'))
  store = new MotifStore(join(dir, 't.db'))
  userId = store.createUser({ name: 'u', email: 'u@e.com', passwordHash: 'x', role: 'user' }).id
  orderId = store.createOrder(userId, { id: 'credits_50', label: '50 张额度', credits: 50, amountTotal: 6800, currency: 'hkd' }, 'mock')
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('creditPaidOrder（幂等入账）', () => {
  it('金额一致：入账一次 ok，重复回调 duplicate 不再加额', () => {
    expect(creditPaidOrder(store, orderId, 6800)).toBe('ok')
    const after1 = store.getUserById(userId)!.credits
    expect(creditPaidOrder(store, orderId, 6800)).toBe('duplicate')
    expect(store.getUserById(userId)!.credits).toBe(after1)
    expect(store.getUserById(userId)!.credits).toBe(50)
  })
  it('金额不一致（篡改）：mismatch，订单保持 pending、余额不动', () => {
    expect(creditPaidOrder(store, orderId, 1)).toBe('mismatch')
    expect(store.getOrder(orderId)!.status).toBe('pending')
    expect(store.getUserById(userId)!.credits).toBe(0)
  })
  it('订单不存在：not_found（区别于 duplicate，供路由回 fail 让网关重试）', () => {
    expect(creditPaidOrder(store, 'ord_none', 1)).toBe('not_found')
  })
  it('orders.channel 落库并随 getOrder 回传', () => {
    const epayOrder = store.createOrder(userId, { id: 'credits_50', label: '50 张额度', credits: 50, amountTotal: 6800, currency: 'hkd' }, 'epay')
    expect(store.getOrder(epayOrder)!.channel).toBe('epay')
    expect(store.getOrder(orderId)!.channel).toBe('mock')
  })
  it('到账写入额度流水（source=order_paid，守恒可追溯）', () => {
    creditPaidOrder(store, orderId, 6800)
    // 断言真正读 credit_ledger：锁定「入账必落流水」而非只看余额
    expect(store.listLedger({ userId, source: 'order_paid' })[0]).toMatchObject({
      delta: 50,
      refId: orderId,
      source: 'order_paid',
    })
  })
})

describe('deleteAuditBefore（审计保留清理）', () => {
  it('只清理截止时间之前的审计', () => {
    store.insertAudit({ actorId: 'a', action: 'x' })
    expect(store.deleteAuditBefore(new Date(Date.now() + 86_400_000).toISOString())).toBeGreaterThanOrEqual(1)
  })
})
