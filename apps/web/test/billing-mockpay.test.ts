import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NextRequest } from 'next/server'
import { MotifStore } from '@motif/db'
import { SESSION_COOKIE } from '@/server/auth'
import { POST as mockPayPOST } from '@/app/api/billing/mock-pay/route'

let dir: string
let store: MotifStore

function reqWith(token: string | undefined, body?: unknown): NextRequest {
  return {
    cookies: { get: (n: string) => (n === SESSION_COOKIE && token ? { value: token } : undefined) },
    json: async () => body,
  } as unknown as NextRequest
}

function sessionFor(role: 'user' | 'admin' | 'root', email: string): string {
  const u = store.createUser({ email, passwordHash: 'h', name: email, role })
  return store.createSession(u.id, 60_000)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'motif-mockpay-'))
  store = new MotifStore(join(dir, 't.db'))
  const g = globalThis as unknown as { __motifRuntime?: unknown }
  g.__motifRuntime = { store } as never
})

afterEach(() => {
  const g = globalThis as unknown as { __motifRuntime?: unknown }
  delete g.__motifRuntime
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

const PKG = { id: 'credits_50', label: '50 张额度', credits: 50, amountTotal: 6800, currency: 'hkd' }

describe('POST /api/billing/mock-pay（模拟收银台两层 403 与归属校验）', () => {
  it('未登录 401', async () => {
    const res = await mockPayPOST(reqWith(undefined, { orderId: 'x' }))
    expect(res.status).toBe(401)
  })

  it('mock 渠道 + mock 订单 + 本人：正常入账', async () => {
    const token = sessionFor('user', 'u@b.co')
    const orderId = store.createOrder(store.getUserByEmail('u@b.co')!.id, PKG, 'mock')
    const res = await mockPayPOST(reqWith(token, { orderId }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { paid: number }
    expect(body.paid).toBe(50)
  })

  it('第一层 403：PAYMENT_CHANNEL 切到真实渠道后，模拟支付被拒（订单也不入账）', async () => {
    const token = sessionFor('user', 'u2@b.co')
    const userId = store.getUserByEmail('u2@b.co')!.id
    const orderId = store.createOrder(userId, PKG, 'mock')
    store.setSetting('PAYMENT_CHANNEL', 'epay')
    const res = await mockPayPOST(reqWith(token, { orderId }))
    expect(res.status).toBe(403)
    expect(store.getOrder(orderId)!.status).toBe('pending') // 没有被免费印钞
  })

  it('第二层 403：全局仍是 mock，但订单创建渠道是 epay（切回 mock 窗口期）→ 拒绝', async () => {
    const token = sessionFor('user', 'u3@b.co')
    const userId = store.getUserByEmail('u3@b.co')!.id
    const orderId = store.createOrder(userId, PKG, 'epay')
    const res = await mockPayPOST(reqWith(token, { orderId }))
    expect(res.status).toBe(403)
    expect(store.getOrder(orderId)!.status).toBe('pending')
    expect(store.getUserById(userId)!.credits).toBe(0)
  })

  it('非本人订单：400 且不入账', async () => {
    sessionFor('user', 'owner@b.co')
    const ownerOrderId = store.createOrder(store.getUserByEmail('owner@b.co')!.id, PKG, 'mock')
    const attacker = sessionFor('user', 'attacker@b.co')
    const res = await mockPayPOST(reqWith(attacker, { orderId: ownerOrderId }))
    expect(res.status).toBe(400)
    expect(store.getOrder(ownerOrderId)!.status).toBe('pending')
  })
})
