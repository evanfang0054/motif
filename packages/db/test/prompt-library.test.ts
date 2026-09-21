import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { MotifStore, type PromptEntryInput, type PromptSourceDefInput } from '../src/index'

let dir: string
let store: MotifStore

const DEF_A: PromptSourceDefInput = { id: 'src-a', name: '源 A', url: 'https://example.com/a.json', homepage: 'https://example.com/a' }
const DEF_B: PromptSourceDefInput = { id: 'src-b', name: '源 B', url: 'https://example.com/b.json', homepage: 'https://example.com/b' }

/** 两次替换用的时间戳（写成真时间，避免被误读成任务编号） */
const NOW_A = '2026-01-01T00:00:00.000Z'
const NOW_B = '2026-01-01T01:00:00.000Z'

function entry(id: string, over: Partial<PromptEntryInput> = {}): PromptEntryInput {
  return {
    id,
    title: `标题 ${id}`,
    prompt: `提示词 ${id}`,
    description: '',
    coverUrl: '',
    referenceImageUrls: [],
    tags: [],
    author: '',
    sourceUrl: '',
    ...over,
  }
}

function columns(dbPath: string, table: string): string[] {
  const db = new Database(dbPath)
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  db.close()
  return rows.map((r) => r.name)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'motif-prompt-'))
  store = new MotifStore(join(dir, 't.db'))
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('提示词库表结构', () => {
  it('两张新表由构造器懒建，列齐备', () => {
    expect(columns(join(dir, 't.db'), 'prompt_sources')).toEqual([
      'id',
      'name',
      'url',
      'homepage',
      'sort_index',
      'entry_count',
      'fetched_at',
      'last_success_at',
      'last_error',
      'signature',
    ])
    expect(columns(join(dir, 't.db'), 'prompt_entries')).toEqual([
      'source_id',
      'id',
      'title',
      'prompt',
      'description',
      'cover_url',
      'reference_image_urls',
      'tags',
      'author',
      'source_url',
      'sort_index',
    ])
  })

  it('重复构造幂等：再开一个实例不会报错，也不会丢数据', () => {
    store.seedPromptSources([DEF_A])
    store.close()
    store = new MotifStore(join(dir, 't.db'))
    store.seedPromptSources([DEF_A])
    expect(store.listPromptSources()).toHaveLength(1)
  })

  it('旧库（无这两张表）启动即补建，既有数据不受影响', () => {
    const dbPath = join(dir, 'old.db')
    const raw = new Database(dbPath)
    raw.exec("CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, name TEXT NOT NULL, credits INTEGER NOT NULL DEFAULT 0, invite_code TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)")
    raw.prepare('INSERT INTO users (id, email, password_hash, name, invite_code, created_at, updated_at) VALUES (?,?,?,?,?,?,?)').run('u1', 'u@e.com', 'x', '老用户', 'INV1', 't', 't')
    raw.close()
    const s = new MotifStore(dbPath)
    expect(s.getUserById('u1')?.name).toBe('老用户')
    s.seedPromptSources([DEF_A])
    expect(s.listPromptSources()).toHaveLength(1)
    s.close()
  })
})

describe('seedPromptSources', () => {
  it('只覆盖清单列，抓取状态列一律保留', () => {
    store.seedPromptSources([DEF_A])
    store.replacePromptEntries('src-a', [entry('1'), entry('2')], { signature: 'sig-1', now: '2026-09-21T00:00:00.000Z' })
    const before = store.listPromptSources()[0]
    expect(before.entryCount).toBe(2)
    expect(before.signature).toBe('sig-1')
    expect(before.lastSuccessAt).toBe('2026-09-21T00:00:00.000Z')

    // 清单改名/改地址/换顺序 —— 状态必须原样活着
    store.seedPromptSources([{ ...DEF_A, name: '源 A 改名', url: 'https://example.com/a2.json' }])
    const after = store.listPromptSources()[0]
    expect(after.name).toBe('源 A 改名')
    expect(after.url).toBe('https://example.com/a2.json')
    expect(after.entryCount).toBe(2)
    expect(after.signature).toBe('sig-1')
    expect(after.lastSuccessAt).toBe('2026-09-21T00:00:00.000Z')
  })

  it('同步清单：不在清单里的源连同条目一起删掉（否则界面上还挑得到代码里已去掉的源）', () => {
    store.seedPromptSources([DEF_A, DEF_B])
    store.replacePromptEntries('src-a', [entry('1')], { signature: 's', now: 'T' })
    store.replacePromptEntries('src-b', [entry('2')], { signature: 's', now: 'T' })
    expect(store.listPromptEntries()).toHaveLength(2)

    store.seedPromptSources([DEF_A]) // 清单里只剩 A
    expect(store.listPromptSources().map((s) => s.id)).toEqual(['src-a'])
    expect(store.listPromptEntries().map((e) => e.id)).toEqual(['1']) // B 的条目随外键级联消失

    // 重新加回清单：行回来了，但抓取状态是从零开始（可接受）
    store.seedPromptSources([DEF_A, DEF_B])
    expect(store.listPromptSources().map((s) => s.id)).toEqual(['src-a', 'src-b'])
    expect(store.listPromptSources()[1]).toMatchObject({ entryCount: 0, fetchedAt: null, lastError: '' })
  })

  it('空清单也能同步（把全部源删掉）', () => {
    store.seedPromptSources([DEF_A])
    store.seedPromptSources([])
    expect(store.listPromptSources()).toEqual([])
  })

  it('sortIndex 跟随数组下标；列表按它排序', () => {
    store.seedPromptSources([DEF_A, DEF_B])
    expect(store.listPromptSources().map((s) => [s.id, s.sortIndex])).toEqual([
      ['src-a', 0],
      ['src-b', 1],
    ])
    store.seedPromptSources([DEF_B, DEF_A])
    expect(store.listPromptSources().map((s) => s.id)).toEqual(['src-b', 'src-a'])
  })
})

describe('replacePromptEntries（整源原子替换）', () => {
  it('替换后旧条目消失、新条目全在，状态列更新、last_error 清空', () => {
    store.seedPromptSources([DEF_A])
    store.recordPromptSourceFailure('src-a', '上次失败了', '2026-09-21T01:00:00.000Z', 'sig')
    expect(store.listPromptSources()[0].lastError).toBe('上次失败了')

    store.replacePromptEntries('src-a', [entry('1'), entry('2'), entry('3')], { signature: 'sig', now: NOW_A })
    expect(store.listPromptEntries().map((e) => e.id)).toEqual(['1', '2', '3'])
    const s = store.listPromptSources()[0]
    expect(s.entryCount).toBe(3)
    expect(s.fetchedAt).toBe(NOW_A)
    expect(s.lastSuccessAt).toBe(NOW_A)
    expect(s.signature).toBe('sig')
    expect(s.lastError).toBe('')

    // 再替换一次：只剩新的一批
    store.replacePromptEntries('src-a', [entry('9')], { signature: 'sig2', now: NOW_B })
    expect(store.listPromptEntries().map((e) => e.id)).toEqual(['9'])
    expect(store.listPromptSources()[0].entryCount).toBe(1)
  })

  it('entry_count 与条目表实际行数不漂移', () => {
    store.seedPromptSources([DEF_A, DEF_B])
    store.replacePromptEntries('src-a', [entry('1'), entry('2')], { signature: 's', now: 'T' })
    store.replacePromptEntries('src-b', [entry('1')], { signature: 's', now: 'T' })
    const rows = store.listPromptEntries()
    for (const src of store.listPromptSources()) {
      expect(rows.filter((r) => r.sourceId === src.id)).toHaveLength(src.entryCount)
    }
  })

  it('tags / referenceImageUrls 往返为数组；脏数据回退空数组', () => {
    store.seedPromptSources([DEF_A])
    store.replacePromptEntries('src-a', [entry('1', { tags: ['写实', '海报'], referenceImageUrls: ['https://x/1.png'] })], {
      signature: 's',
      now: 'T',
    })
    const row = store.listPromptEntries()[0]
    expect(row.tags).toEqual(['写实', '海报'])
    expect(row.referenceImageUrls).toEqual(['https://x/1.png'])

    const raw = new Database(join(dir, 't.db'))
    raw.prepare("UPDATE prompt_entries SET tags = '{不是数组', reference_image_urls = 'null' WHERE id = '1'").run()
    raw.close()
    const dirty = store.listPromptEntries()[0]
    expect(dirty.tags).toEqual([])
    expect(dirty.referenceImageUrls).toEqual([])
  })

  it('条目带源名与源内顺序；跨源按源的 sort_index 排', () => {
    store.seedPromptSources([DEF_A, DEF_B])
    store.replacePromptEntries('src-b', [entry('b1')], { signature: 's', now: 'T' })
    store.replacePromptEntries('src-a', [entry('a1'), entry('a2')], { signature: 's', now: 'T' })
    expect(store.listPromptEntries().map((e) => [e.sourceName, e.id])).toEqual([
      ['源 A', 'a1'],
      ['源 A', 'a2'],
      ['源 B', 'b1'],
    ])
  })
})

describe('recordPromptSourceFailure', () => {
  it('更新 fetched_at / last_error / signature；条目 / last_success_at / entry_count 不动', () => {
    store.seedPromptSources([DEF_A])
    store.replacePromptEntries('src-a', [entry('1'), entry('2')], { signature: 'sig', now: 'T-ok' })
    store.recordPromptSourceFailure('src-a', '抓取超时', 'T-fail', 'sig2')

    const s = store.listPromptSources()[0]
    expect(s.fetchedAt).toBe('T-fail')
    expect(s.lastError).toBe('抓取超时')
    expect(s.signature).toBe('sig2')
    expect(s.lastSuccessAt).toBe('T-ok')
    expect(s.entryCount).toBe(2)
    expect(store.listPromptEntries().map((e) => e.id)).toEqual(['1', '2'])
  })

  it('失败也记签名：从未成功过的源不会因为签名恒为空而被反复判陈旧', () => {
    // 若失败不记签名，签名会一直是 ''，与代码清单的签名不等 ⇒ 每次读都判陈旧
    store.seedPromptSources([DEF_A])
    store.recordPromptSourceFailure('src-a', '挂了', 'T', 'sig-of-def')
    expect(store.listPromptSources()[0].signature).toBe('sig-of-def')
  })

  it('错误摘要截断，不把整段 HTML 塞进库', () => {
    store.seedPromptSources([DEF_A])
    store.recordPromptSourceFailure('src-a', 'x'.repeat(1000), 'T', 'sig')
    expect(store.listPromptSources()[0].lastError).toHaveLength(300)
  })
})

describe('提示词库与既有表互不影响', () => {
  it('删源不会误删别的表；级联只作用于该源的条目', () => {
    store.seedPromptSources([DEF_A, DEF_B])
    store.replacePromptEntries('src-a', [entry('1')], { signature: 's', now: 'T' })
    store.replacePromptEntries('src-b', [entry('1')], { signature: 's', now: 'T' })
    store.db.prepare('DELETE FROM prompt_sources WHERE id = ?').run('src-a')
    expect(store.listPromptSources().map((s) => s.id)).toEqual(['src-b'])
    expect(store.listPromptEntries().map((e) => [e.sourceId, e.id])).toEqual([['src-b', '1']])
  })
})
