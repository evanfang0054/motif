import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { NextRequest } from 'next/server'
import { MotifStore } from '@motif/db'
import { SESSION_COOKIE } from '@/server/auth'
import * as ordersRoute from '@/app/api/admin/orders/route'

let dir: string
let store: MotifStore

function req(token: string | undefined, query = ''): NextRequest {
  return {
    cookies: { get: (n: string) => (n === SESSION_COOKIE && token ? { value: token } : undefined) },
    nextUrl: new URL(`http://localhost:3100/api/admin/orders${query}`),
  } as unknown as NextRequest
}

function sessionFor(role: 'user' | 'admin' | 'root', email: string): string {
  const u = store.createUser({ email, passwordHash: 'h', name: email, role })
  return store.createSession(u.id, 60_000)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'motif-admin-order-'))
  store = new MotifStore(join(dir, 't.db'))
  const g = globalThis as unknown as { __motifRuntime?: { store: MotifStore } }
  g.__motifRuntime = { store } as never
})

afterEach(() => {
  const g = globalThis as unknown as { __motifRuntime?: unknown }
  delete g.__motifRuntime
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('C4 契约：订单管理只读', () => {
  it('route 模块导出的 HTTP 动词恰好只有 GET', () => {
    // 只按 HTTP 动词白名单过滤：对 segment config（dynamic / fetchCache / maxDuration …）
    // 完全免疫，避免将来有人合法加了 fetchCache 就误红
    const HTTP_VERBS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']
    const verbs = Object.keys(ordersRoute)
      .filter((k) => HTTP_VERBS.includes(k))
      .sort()
    expect(verbs).toEqual(['GET'])
  })

  it('订单目录下不存在 [id] 等子路由（走查目录，新增写端点文件时必红）', () => {
    // 用 import.meta.url 定位：断言不受运行 cwd 影响
    const base = fileURLToPath(new URL('../src/app/api/admin/orders', import.meta.url))
    expect(existsSync(join(base, 'route.ts'))).toBe(true)
    // 目录级走查：只有 route.ts 一个文件，没有带写方法的子路由
    expect(readdirSync(base).sort()).toEqual(['route.ts'])
  })
})

describe('访问控制', () => {
  it('未登录 401 / 普通用户 403 / 管理员 200', async () => {
    expect((await ordersRoute.GET(req(undefined))).status).toBe(401)
    expect((await ordersRoute.GET(req(sessionFor('user', 'u@b.co')))).status).toBe(403)
    expect((await ordersRoute.GET(req(sessionFor('admin', 'a@b.co')))).status).toBe(200)
  })
})

describe('列表内容', () => {
  it('返回订单字段且可按状态筛选', async () => {
    const buyer = store.createUser({ email: 'buy@b.co', passwordHash: 'h', name: '买家' })
    const id = store.createOrder(buyer.id, { id: 'credits_50', label: '50 张额度', credits: 50, amountTotal: 868, currency: 'hkd' })
    store.payOrder(id, buyer.id)
    const id2 = store.createOrder(buyer.id, { id: 'credits_100', label: '100 张额度', credits: 100, amountTotal: 1736, currency: 'hkd' })

    const t = sessionFor('admin', 'a2@b.co')
    const all = (await (await ordersRoute.GET(req(t))).json()) as { items: Array<Record<string, unknown>>; total: number }
    expect(all.total).toBe(2)

    // 字段映射是这段代码真正的风险（库内 snake_case → 接口 camelCase），逐字段断言
    const pending = all.items.find((r) => r.id === id2)!
    expect(pending.userId).toBe(buyer.id)
    expect(pending.packageId).toBe('credits_100')
    expect(pending.credits).toBe(100)
    expect(pending.amountTotal).toBe(1736) // 单位：分（HK$17.36）
    expect(pending.currency).toBe('hkd')
    expect(pending.status).toBe('pending')
    expect(pending.paidAt).toBeNull()
    expect(pending.createdAt).toBeTruthy()
    // 不得把库内 snake_case 列名漏给前端
    expect(Object.keys(pending).some((k) => k.includes('_'))).toBe(false)

    const paid = (await (await ordersRoute.GET(req(t, '?status=paid'))).json()) as { total: number; items: Array<Record<string, unknown>> }
    expect(paid.total).toBe(1)
    expect(paid.items[0].id).toBe(id)
    expect(paid.items[0].paidAt).toBeTruthy()

    // userId 筛选：另一个用户不应出现在结果里
    const other = store.createUser({ email: 'other@b.co', passwordHash: 'h', name: '别人' })
    store.createOrder(other.id, { id: 'credits_50', label: '50 张额度', credits: 50, amountTotal: 868, currency: 'hkd' })
    const mine = (await (await ordersRoute.GET(req(t, `?userId=${buyer.id}`))).json()) as { total: number }
    expect(mine.total).toBe(2)
  })
})
