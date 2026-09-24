import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { MotifStore } from '../src/index'
import { DEFAULT_CANVAS_META, placementRect, type CanvasRect } from '@motif/core'

/** 测试内联的矩形相交（贴边不算），与 lib/canvas/geometry.ts 的 rectsIntersect 同语义 */
function overlaps(a: CanvasRect, b: CanvasRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

let dir: string
let store: MotifStore
let userId: string
let topicId: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'motif-canvas-'))
  store = new MotifStore(join(dir, 't.db'))
  userId = store.createUser({ name: 'u', email: 'u@e.com', passwordHash: 'x', role: 'user' }).id
  topicId = store.createTopic(userId, '任务A').id
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

function columns(dbPath: string, table: string): string[] {
  const db = new Database(dbPath, { readonly: true })
  const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name)
  db.close()
  return cols
}

describe('迁移安全', () => {
  it('canvas_images 同时存在原图尺寸列与画布显示尺寸列，且新列名不是 width/height', () => {
    const cols = columns(join(dir, 't.db'), 'canvas_images')
    // 原图尺寸列（既有，表示原图像素尺寸）
    expect(cols).toContain('width')
    expect(cols).toContain('height')
    // 画布显示尺寸列（新增，命名刻意避开 width/height）
    expect(cols).toContain('canvas_x')
    expect(cols).toContain('canvas_y')
    expect(cols).toContain('canvas_w')
    expect(cols).toContain('canvas_h')
    expect(cols).toContain('updated_at')
    // 新增列里不得出现第二个 width/height
    expect(cols.filter((c) => c === 'width')).toHaveLength(1)
    expect(cols.filter((c) => c === 'height')).toHaveLength(1)
    // 画布升级对 canvas_images 只加 5 列（13 → 18）
    expect(cols).toHaveLength(18)
  })

  it('topics.canvas_meta 存在且默认 {}，且**只**多这一列', () => {
    const cols = columns(join(dir, 't.db'), 'topics')
    expect(cols).toContain('canvas_meta')
    // 画布升级对 topics 只加 1 列（8 → 9）
    expect(cols).toHaveLength(9)
    expect(store.getCanvasMeta(topicId)).toEqual(DEFAULT_CANVAS_META)
  })

  it('库内表清单快照（画布升级本身零新表；新增表必须同步这里）', () => {
    const db = new Database(join(dir, 't.db'), { readonly: true })
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>)
      .map((t) => t.name)
      .sort()
    db.close()
    expect(tables).toEqual([
      'admin_audit',
      'canvas_images',
      'cdks',
      'credit_ledger',
      'feedback',
      'messages',
      'orders',
      // 提示词库的表（canvas 升级之后新增；画布升级自身仍是零新表）
      'prompt_entries',
      'prompt_sources',
      'reference_uploads',
      'sessions',
      'settings',
      'topics',
      'users',
      'verification_codes',
    ])
  })

  it('无新列的旧库启动后自动补齐，服务可访问', () => {
    // 造一个「升级前」的库：手工建最小 canvas_images + topics，不带新列
    const oldPath = join(dir, 'old.db')
    const old = new Database(oldPath)
    old.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, name TEXT NOT NULL,
        avatar_url TEXT, role TEXT NOT NULL DEFAULT 'user', status TEXT NOT NULL DEFAULT 'active',
        must_change_password INTEGER NOT NULL DEFAULT 0, disabled_at TEXT, credits INTEGER NOT NULL DEFAULT 0,
        invite_code TEXT NOT NULL UNIQUE, invited_by TEXT, invited_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE topics (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'idle',
        active_message_id TEXT, active_prompt TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE canvas_images (id TEXT PRIMARY KEY, topic_id TEXT NOT NULL, user_id TEXT NOT NULL, message_id TEXT,
        origin TEXT NOT NULL, serial INTEGER NOT NULL, name TEXT NOT NULL, image_key TEXT NOT NULL,
        mime_type TEXT NOT NULL, bytes INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
        created_at TEXT NOT NULL);
    `)
    old.close()
    const upgraded = new MotifStore(oldPath)
    const cols = columns(oldPath, 'canvas_images')
    expect(cols).toContain('canvas_x')
    expect(columns(oldPath, 'topics')).toContain('canvas_meta')
    // 服务可访问：能正常读写
    expect(upgraded.getCanvasMeta('nope')).toEqual(DEFAULT_CANVAS_META)
    upgraded.close()
  })
})

/** 存储层断言。⚠️ 这里钉的是**服务端可观测的那一半**：
 * 「客户端收到 rejected 后用服务端值覆盖本地并提示」这条完整断言里，
 * 客户端侧由画布侧的测试覆盖，这里只钉住它依赖的前提（服务端确实回了 rejected）。 */
describe('图片级 LWW', () => {
  function makeImage(): string {
    return store.insertCanvasImage({
      topicId, userId, messageId: null, origin: 'generated', name: '图片 1',
      imageKey: 'k1', mimeType: 'image/webp', bytes: 1, width: 1024, height: 1024,
    }).id
  }

  it('updated_at 更旧的 upsert 被拒，库中值不变', () => {
    const id = makeImage()
    store.upsertCanvasPlacements(topicId, [
      { id, canvasX: 100, canvasY: 100, canvasWidth: 240, canvasHeight: 240, updatedAt: '2026-09-20T10:00:00.000Z' },
    ])
    const r = store.upsertCanvasPlacements(topicId, [
      { id, canvasX: 999, canvasY: 999, canvasWidth: 240, canvasHeight: 240, updatedAt: '2026-09-20T09:00:00.000Z' },
    ])
    expect(r.rejected).toEqual([id])
    expect(r.applied).toEqual([])
    expect(store.listCanvasPlacements(topicId)[0].canvasX).toBe(100)
  })

  it('updated_at 更晚的 upsert 生效', () => {
    const id = makeImage()
    store.upsertCanvasPlacements(topicId, [
      { id, canvasX: 100, canvasY: 100, canvasWidth: 240, canvasHeight: 240, updatedAt: '2026-09-20T09:00:00.000Z' },
    ])
    const r = store.upsertCanvasPlacements(topicId, [
      { id, canvasX: 300, canvasY: 300, canvasWidth: 240, canvasHeight: 240, updatedAt: '2026-09-20T10:00:00.000Z' },
    ])
    expect(r.applied).toEqual([id])
    expect(store.listCanvasPlacements(topicId)[0].canvasX).toBe(300)
  })

  it('不存在的 id 进 rejected（已删除的图）', () => {
    const r = store.upsertCanvasPlacements(topicId, [
      { id: 'cimg_nope', canvasX: 1, canvasY: 1, canvasWidth: 1, canvasHeight: 1, updatedAt: '2026-09-20T10:00:00.000Z' },
    ])
    expect(r.rejected).toEqual(['cimg_nope'])
  })
})

describe('旧库补位', () => {
  it('updated_at 为空的行按 serial 分配位置；连续两次调用位置不变（幂等）', () => {
    const a = store.insertCanvasImage({ topicId, userId, messageId: null, origin: 'generated', name: 'a', imageKey: 'ka', mimeType: 'image/webp', bytes: 1, width: 1024, height: 1024 }).id
    const b = store.insertCanvasImage({ topicId, userId, messageId: null, origin: 'generated', name: 'b', imageKey: 'kb', mimeType: 'image/webp', bytes: 1, width: 1024, height: 1024 }).id
    // 模拟升级库：手工把两行的位置清空
    store.db.prepare("UPDATE canvas_images SET updated_at = '', canvas_x = 0, canvas_y = 0 WHERE topic_id = ?").run(topicId)

    expect(store.backfillCanvasPlacements(topicId)).toBe(2)
    const first = store.listCanvasPlacements(topicId)
    // 按 serial 顺序：a 在前
    expect(first[0].id).toBe(a)
    expect(first[1].id).toBe(b)
    // 两两矩形不相交
    const ra = placementRect(first[0])
    const rb = placementRect(first[1])
    expect(overlaps(ra, rb)).toBe(false)

    expect(store.backfillCanvasPlacements(topicId)).toBe(0) // 幂等：无待补位行
    expect(store.listCanvasPlacements(topicId)).toEqual(first)
  })

  it('已有非零位置的行不被补位改动', () => {
    const a = store.insertCanvasImage({ topicId, userId, messageId: null, origin: 'generated', name: 'a', imageKey: 'ka', mimeType: 'image/webp', bytes: 1, width: 1024, height: 1024 }).id
    const b = store.insertCanvasImage({ topicId, userId, messageId: null, origin: 'generated', name: 'b', imageKey: 'kb', mimeType: 'image/webp', bytes: 1, width: 1024, height: 1024 }).id
    store.upsertCanvasPlacements(topicId, [
      { id: a, canvasX: 777, canvasY: 888, canvasWidth: 240, canvasHeight: 240, updatedAt: '2026-09-20T10:00:00.000Z' },
    ])
    store.backfillCanvasPlacements(topicId)
    const after = store.listCanvasPlacements(topicId)
    // 已落位的 a 一字不动
    expect(after.find((p) => p.id === a)).toMatchObject({ canvasX: 777, canvasY: 888, canvasWidth: 240, canvasHeight: 240 })
    // b 被补位：拿到了真实槽位（尺寸/版本都写上了），且不与 a 重叠
    const pb = after.find((p) => p.id === b)!
    expect(pb.canvasWidth).toBeGreaterThan(0)
    expect(pb.updatedAt).not.toBe('')
    expect(overlaps(placementRect(after.find((p) => p.id === a)!), placementRect(pb))).toBe(false)
    // ⚠️ 槽位原点即视口原点（默认视口 → 世界 (0,0)），故 0 是合法槽位坐标：
    // 这里断言的是「位置与 a 不同」，不是「非 0」。
    expect([pb.canvasX, pb.canvasY]).not.toEqual([777, 888])
  })
})

describe('insertCanvasImage 带 placement', () => {
  it('位置列与图片行在同一条 INSERT 落库（原子），updatedAt 非空故不参与补位', () => {
    const img = store.insertCanvasImage({
      topicId, userId, messageId: null, origin: 'generated', name: 'a', imageKey: 'ka',
      mimeType: 'image/webp', bytes: 1, width: 1024, height: 1024,
      placement: { x: 12, y: 34, width: 240, height: 120 },
    })
    // 返回值即已带位置
    expect(img).toMatchObject({ canvasX: 12, canvasY: 34, canvasWidth: 240, canvasHeight: 120 })
    expect(img.updatedAt).not.toBe('')
    // 落库可读回
    expect(store.listCanvasPlacements(topicId)[0]).toMatchObject({
      id: img.id, canvasX: 12, canvasY: 34, canvasWidth: 240, canvasHeight: 120,
    })
    // updatedAt 非空 → 补位不认领它
    expect(store.backfillCanvasPlacements(topicId)).toBe(0)
    expect(store.listCanvasPlacements(topicId)[0].canvasX).toBe(12)
  })

  it('缺省 placement 时落 0 位置 + 空 updatedAt，等首次 GET 补位', () => {
    const img = store.insertCanvasImage({
      topicId, userId, messageId: null, origin: 'generated', name: 'a', imageKey: 'ka',
      mimeType: 'image/webp', bytes: 1, width: 1024, height: 1024,
    })
    expect(img).toMatchObject({ canvasX: 0, canvasY: 0, canvasWidth: 0, canvasHeight: 0, updatedAt: '' })
    expect(store.backfillCanvasPlacements(topicId)).toBe(1)
    const placed = store.listCanvasPlacements(topicId)[0]
    expect(placed.canvasWidth).toBe(240)
    expect(placed.updatedAt).not.toBe('')
  })
})

describe('messages.slot_plan（#88：槽位计划挂 message 上，零新表）', () => {
  function makeMessage(slotPlan?: CanvasRect[]) {
    return store.createMessage({
      topicId, userId, prompt: 'p', finalPrompt: 'p', size: '1024x1024',
      requestedCount: 2, enhancePrompt: false, slotPlan,
    })
  }

  it('列存在（本用例走新建库路径，列来自 CREATE TABLE；旧库 ALTER 迁移由 store.test.ts 的 makeLegacyDb 覆盖）', () => {
    expect(columns(join(dir, 't.db'), 'messages')).toContain('slot_plan')
  })

  it('计划可落库并原样读回', () => {
    const plan: CanvasRect[] = [
      { x: 0, y: 0, w: 240, h: 240 },
      { x: 280, y: 0, w: 160, h: 240 },
    ]
    const m = makeMessage(plan)
    expect(store.getMessage(m.id)!.slotPlan).toEqual(plan)
  })

  it('缺省 = 空数组（老消息没有骨架，退回现场分配）', () => {
    expect(makeMessage().slotPlan).toEqual([])
  })

  it('脏 JSON / 坏形状逐项丢弃，不抛错', () => {
    const dirty = makeMessage().id
    const partial = makeMessage().id
    const db = new Database(join(dir, 't.db'))
    db.prepare('UPDATE messages SET slot_plan = ? WHERE id = ?').run('{不是 json', dirty)
    db.prepare('UPDATE messages SET slot_plan = ? WHERE id = ?').run(
      JSON.stringify([{ x: 1, y: 2, w: 240, h: 240 }, { x: 'a', y: 0, w: 1, h: 1 }, { x: 0, y: 0, w: -1, h: 10 }]),
      partial
    )
    db.close()
    expect(store.getMessage(dirty)!.slotPlan).toEqual([])
    expect(store.getMessage(partial)!.slotPlan).toEqual([{ x: 1, y: 2, w: 240, h: 240 }])
  })
})
