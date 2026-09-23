import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MotifStore } from '../src/index'

/**
 * 管理端「按人定位」与「会话过期」两组新能力的存储层用例（#75-3.1 / #75-3.4）。
 *
 * 这组用例刻意钉在**语义**上，而不只是「方法存在」：
 *  - 搜索要能按裸 `usr_` ID 精确命中（此前贴 ID 得 0 条，追溯链路是断的）
 *  - 筛选词要能解析成候选集，且**解析不到人时必须返回 0 条**（空数组不能退化成「不过滤」）
 *  - 「过期」必须与「不存在」分开，否则要么给不出引导、要么向探路者泄露管理面
 */

let dir: string
let store: MotifStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'motif-admin-resolve-'))
  store = new MotifStore(join(dir, 't.db'))
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

function user(email: string, name: string) {
  return store.createUser({ email, passwordHash: 'h', name })
}

describe('用户搜索：按裸 ID 精确命中', () => {
  it('邮箱 / 昵称模糊匹配仍然有效（不回归）', () => {
    user('alice@b.co', '爱丽丝')
    expect(store.listUsers({ q: 'alice' })).toHaveLength(1)
    expect(store.listUsers({ q: '爱丽丝' })).toHaveLength(1)
  })

  it('把完整 usr_ ID 原样贴进搜索框能定位到该用户（此前恒为 0 条）', () => {
    const a = user('alice@b.co', '爱丽丝')
    user('bob@b.co', '鲍勃')

    const hit = store.listUsers({ q: a.id })
    expect(hit).toHaveLength(1)
    expect(hit[0].id).toBe(a.id)
    expect(store.countUsers({ q: a.id })).toBe(1)
  })

  it('ID 匹配是**精确**的：前缀不命中（否则 ID 会互相污染）', () => {
    const a = user('alice@b.co', '爱丽丝')
    // 取 ID 去掉最后一个字符：它既不是任何 id，也不该被当作昵称/邮箱子串命中
    expect(store.listUsers({ q: a.id.slice(0, -1) })).toHaveLength(0)
  })

  it('搜索词里的前后空白不影响命中', () => {
    const a = user('alice@b.co', '爱丽丝')
    expect(store.listUsers({ q: `  ${a.id}  ` })).toHaveLength(1)
  })
})

describe('findUserIdsByTerm：把筛选词解析成人', () => {
  it('裸 ID 优先走精确匹配', () => {
    const a = user('alice@b.co', '爱丽丝')
    expect(store.findUserIdsByTerm(a.id)).toEqual([a.id])
  })

  it('邮箱与昵称走模糊匹配，可命中多人', () => {
    const a = user('shared@b.co', '甲')
    const b = user('other@b.co', '乙')
    expect(new Set(store.findUserIdsByTerm('shared@b.co'))).toEqual(new Set([a.id]))
    expect(new Set(store.findUserIdsByTerm('@b.co'))).toEqual(new Set([a.id, b.id]))
  })

  it('解析不到人时返回空数组（而不是 null / 全部）', () => {
    user('alice@b.co', '爱丽丝')
    expect(store.findUserIdsByTerm('查无此人')).toEqual([])
  })

  it('空串 / 纯空白返回空数组', () => {
    user('alice@b.co', '爱丽丝')
    expect(store.findUserIdsByTerm('')).toEqual([])
    expect(store.findUserIdsByTerm('   ')).toEqual([])
  })
})

describe('listUserBriefs：批量取「昵称 + 邮箱」摘要', () => {
  it('返回 id / name / email 三列，且只含查得到的 id', () => {
    const a = user('alice@b.co', '爱丽丝')
    const briefs = store.listUserBriefs([a.id, 'usr_not_exist'])
    expect(briefs).toEqual([{ id: a.id, name: '爱丽丝', email: 'alice@b.co' }])
  })

  it('重复 id 去重（同一个人可能同时出现在「提交用户」与「处理人」两列）', () => {
    const a = user('alice@b.co', '爱丽丝')
    expect(store.listUserBriefs([a.id, a.id, a.id])).toHaveLength(1)
  })

  it('空数组 / 空串不查库、返回空数组', () => {
    expect(store.listUserBriefs([])).toEqual([])
    expect(store.listUserBriefs([''])).toEqual([])
  })
})

describe('getExpiredSessionUser：把「过期」与「不存在」分开', () => {
  it('有效会话不算过期（返回 null，走正常鉴权）', () => {
    const a = user('alice@b.co', '爱丽丝')
    const token = store.createSession(a.id, 60_000)
    expect(store.getUserBySession(token)?.id).toBe(a.id)
    expect(store.getExpiredSessionUser(token)).toBeNull()
  })

  it('已过期的会话返回其持有者（用于「登录已过期」引导）', () => {
    const a = user('alice@b.co', '爱丽丝')
    const token = store.createSession(a.id, -1000) // 负 TTL = 立刻过期
    expect(store.getUserBySession(token)).toBeNull() // 正常鉴权：已失效
    expect(store.getExpiredSessionUser(token)?.id).toBe(a.id) // 但能认出是谁的过期会话
  })

  it('未知 token 返回 null（探路者拿不到过期引导，管理面存在性不泄露）', () => {
    expect(store.getExpiredSessionUser('not-a-real-token')).toBeNull()
  })

  it('会话被显式删除后返回 null（登出后刷新子页仍是 404，不冒充「过期」）', () => {
    const a = user('alice@b.co', '爱丽丝')
    const token = store.createSession(a.id, -1000)
    store.deleteSession(token)
    expect(store.getExpiredSessionUser(token)).toBeNull()
  })
})

describe('生成日志：按解析出的候选集筛选', () => {
  function seedMessage(userId: string, topicId: string, prompt: string) {
    return store.createMessage({
      topicId,
      userId,
      prompt,
      finalPrompt: prompt,
      size: '1:1',
      requestedCount: 1,
      enhancePrompt: false,
      referenceIds: [],
    })
  }

  it('userIds 命中多人；undefined 表示不过滤；空数组表示「没有匹配的人」→ 0 条', () => {
    const a = user('a@b.co', '甲')
    const b = user('b@b.co', '乙')
    const ta = store.createTopic(a.id, 'ta')
    const tb = store.createTopic(b.id, 'tb')
    seedMessage(a.id, ta.id, '甲的提示词')
    seedMessage(b.id, tb.id, '乙的提示词')

    expect(store.countAllMessages({})).toBe(2)
    expect(store.countAllMessages({ userIds: [a.id] })).toBe(1)
    expect(store.countAllMessages({ userIds: [a.id, b.id] })).toBe(2)
    // ⚠️ 关键：空数组必须落成恒假条件。若被当成「不过滤」，页面会把全量数据当成筛选结果返回
    expect(store.countAllMessages({ userIds: [] })).toBe(0)
    expect(store.listAllMessages({ userIds: [] })).toHaveLength(0)

    const one = store.listAllMessages({ userIds: [b.id] })
    expect(one).toHaveLength(1)
    expect(one[0].prompt).toBe('乙的提示词')
  })

  it('旧的 userId 精确匹配仍然可用（既有调用点与测试依赖它）', () => {
    const a = user('a2@b.co', '甲')
    const ta = store.createTopic(a.id, 'ta2')
    seedMessage(a.id, ta.id, 'x')
    expect(store.countAllMessages({ userId: a.id })).toBe(1)
    expect(store.countAllMessages({ userId: 'usr_nope' })).toBe(0)
  })
})

describe('审计日志：按解析出的候选集筛选', () => {
  it('userIds 命中多个操作者；空数组 → 0 条；undefined → 全部', () => {
    const a = user('root1@b.co', '超管甲')
    const b = user('root2@b.co', '超管乙')
    store.insertAudit({ actorId: a.id, action: 'credit.adjust' })
    store.insertAudit({ actorId: b.id, action: 'user.disable' })

    expect(store.countAudit({})).toBe(2)
    expect(store.countAudit({ userIds: [a.id] })).toBe(1)
    expect(store.countAudit({ userIds: [a.id, b.id] })).toBe(2)
    expect(store.countAudit({ userIds: [] })).toBe(0)
    expect(store.listAuditPaged({ userIds: [] })).toHaveLength(0)
    expect(store.listAuditPaged({ userIds: [b.id] })[0].action).toBe('user.disable')
  })

  it('userIds 与 action 是 AND 关系（两个条件都要满足）', () => {
    const a = user('root3@b.co', '超管丙')
    store.insertAudit({ actorId: a.id, action: 'credit.adjust' })
    store.insertAudit({ actorId: a.id, action: 'user.disable' })
    expect(store.countAudit({ userIds: [a.id], action: 'credit.adjust' })).toBe(1)
  })

  it('旧的 actorId 精确匹配仍然可用', () => {
    const a = user('root4@b.co', '超管丁')
    store.insertAudit({ actorId: a.id, action: 'credit.adjust' })
    expect(store.countAudit({ actorId: a.id })).toBe(1)
  })
})

describe('订单列表：按解析出的候选集筛选（与审计 / 生成日志同口径）', () => {
  const pkg = { id: 'p50', label: '50 张', credits: 50, amountTotal: 6800, currency: 'hkd' }

  it('userIds 命中指定用户的订单；空数组 → 0 条；undefined → 全部', () => {
    const a = user('buyer@b.co', '买家甲')
    const b = user('buyer2@b.co', '买家乙')
    store.createOrder(a.id, pkg)
    store.createOrder(b.id, pkg)
    store.createOrder(b.id, pkg)

    expect(store.countOrders({})).toBe(3)
    expect(store.countOrders({ userIds: [a.id] })).toBe(1)
    expect(store.countOrders({ userIds: [a.id, b.id] })).toBe(3)
    expect(store.countOrders({ userIds: [] })).toBe(0)
    expect(store.listOrders({ userIds: [] })).toHaveLength(0)
    expect(store.listOrders({ userIds: [b.id] })).toHaveLength(2)
  })

  it('旧的 userId 精确匹配仍然可用', () => {
    const a = user('buyer3@b.co', '买家丙')
    store.createOrder(a.id, pkg)
    expect(store.countOrders({ userId: a.id })).toBe(1)
    expect(store.countOrders({ userId: 'usr_nope' })).toBe(0)
  })

  it('userIds 与 status 是 AND 关系', () => {
    const a = user('buyer4@b.co', '买家丁')
    store.createOrder(a.id, pkg) // 默认 pending
    expect(store.countOrders({ userIds: [a.id], status: 'pending' })).toBe(1)
    expect(store.countOrders({ userIds: [a.id], status: 'paid' })).toBe(0)
  })
})

describe('概览的订单总数（口径标注用）', () => {
  it('total 是 COUNT(*)，不靠 paid + pending 现算 —— 出现第三种状态也不会少算', () => {
    const a = user('ov@b.co', '甲')
    const pkg = { id: 'p50', label: '50 张', credits: 50, amountTotal: 6800, currency: 'hkd' }
    const paid = store.createOrder(a.id, pkg)
    store.createOrder(a.id, pkg) // 保持 pending
    store.db.prepare("UPDATE orders SET status = 'paid' WHERE id = ?").run(paid)
    // 造一个「第三种状态」：库里没有 CHECK 约束，历史数据/将来扩展都可能出现
    const weird = store.createOrder(a.id, pkg)
    store.db.prepare("UPDATE orders SET status = 'refunded' WHERE id = ?").run(weird)

    const ov = store.overviewStats()
    expect(ov.orders.total).toBe(3)
    expect(ov.orders.paid).toBe(1)
    expect(ov.orders.pending).toBe(1)
    // 这正是「用 paid + pending 冒充总数」会漏掉的那一笔
    expect(ov.orders.paid + ov.orders.pending).toBeLessThan(ov.orders.total)
  })
})
