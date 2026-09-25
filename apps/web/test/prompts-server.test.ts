import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MotifStore } from '@motif/db'
import { BUILT_IN_PROMPT_ENTRIES, BUILT_IN_PROMPT_SOURCE } from '@/lib/prompt-builtins'
import { BUILT_IN_PROMPT_SOURCES, REMOTE_PROMPT_SOURCES, isFetchableSource } from '@/lib/prompt-sources'
import { attachPromptImage, isAttachableImage, isSafePublicAssetPath, loadPromptLibrary, refreshPromptSources } from '@/server/prompts'
import { resetRateLimiter } from '@/server/rate-limit'
import { ServiceError } from '@/server/services'
import { existsSync, readdirSync } from 'node:fs'

/** 可抓取的远程源数（5 个 GPT 系）—— 抓取/失败相关断言的基数 */
const REMOTE = REMOTE_PROMPT_SOURCES.length
/** 全部内置源数（含不可抓取的「系统自带」） */
const ALL = BUILT_IN_PROMPT_SOURCES.length
/** 「系统自带」的条目数（原「从模板开始」的 8 个模板） */
const BUILTIN = BUILT_IN_PROMPT_ENTRIES.length

let dir: string
let store: MotifStore

/** 一个可控的假 fetch：按 url 返回预设 JSON 或抛错，并记录调用次数 */
function fakeFetch(handler: (url: string) => unknown) {
  const calls: string[] = []
  const impl = (async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)
    const out = handler(url)
    if (out instanceof Error) throw out
    return { ok: true, status: 200, json: async () => out } as unknown as Response
  }) as unknown as typeof fetch
  return { impl, calls }
}

/** 每个源返回 N 条可区分的条目 */
function payloadFor(sourceId: string, n: number, over: Array<Record<string, unknown>> = []) {
  return Array.from({ length: n }, (_, i) => ({
    id: `${sourceId}-${i}`,
    title: `${sourceId} 标题 ${i}`,
    prompt: `${sourceId} 正文 ${i}`,
    tags: [`标签${i % 2}`],
    ...(over[i] ?? {}),
  }))
}

const query = { keyword: '', tags: [], source: 'all', page: 1, pageSize: 20 }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'motif-prompts-'))
  store = new MotifStore(join(dir, 't.db'))
  resetRateLimiter()
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('首次打开不阻塞', () => {
  it('首次打开不阻塞：立即返回「系统自带」条目 + pending，抓完再读能拿到外部源内容', async () => {
    const { impl, calls } = fakeFetch((url) => payloadFor(url, 2))
    const first = await loadPromptLibrary(store, query, impl)
    expect(first.pending).toBe(true)
    // 「系统自带」是本地播种的，所以首帧就有内容（不是空列表）—— 「不阻塞」的新形态
    expect(first.items).toHaveLength(BUILTIN)
    expect(first.items.every((i) => i.sourceId === BUILT_IN_PROMPT_SOURCE.id)).toBe(true)
    // 不阻塞的证据：返回时后台抓取还没落地，但调用本身没有等 5 个源串完
    expect(calls.length).toBeGreaterThan(0)

    // 等后台抓取完成（同一个单飞 Promise 会被复用，所以再抓一次是安全的）
    await refreshPromptSources(store, undefined, impl)
    const second = await loadPromptLibrary(store, query, impl)
    expect(second.pending).toBe(false)
    expect(second.items).toHaveLength(BUILTIN + REMOTE * 2)
  })

  it('外部源都新鲜时不再 pending（系统自带不参与陈旧判定）', async () => {
    const { impl } = fakeFetch(() => payloadFor('x', 1))
    await refreshPromptSources(store, undefined, impl)
    const r = await loadPromptLibrary(store, query, impl)
    expect(r.pending).toBe(false)
  })

  it('首次抓取全部失败时：内容照常可用，失败仍驱动后台重抓', async () => {
    const { impl, calls } = fakeFetch(() => new Error('fetch failed'))
    const r = await loadPromptLibrary(store, query, impl)
    expect(r.pending).toBe(true)
    expect(r.items).toHaveLength(BUILTIN) // 系统自带照常可用，外部源还在抓
    // ⚠️ 只断言 pending 是弱断言（它在后台刷新之前就算好、新库上恒为 true）——
    // 必须同时证明「失败仍驱动了后台重抓」，否则这条用例即便一次都没抓也会绿。
    await new Promise((res) => setTimeout(res, 0))
    expect(calls.length).toBe(REMOTE)
    // ⚠️ 管理端那条（lastError）必须仍是**原文** —— 运营要靠它看具体原因
    await refreshPromptSources(store, undefined, impl)
    expect(fetchableSources().every((s) => s.lastError === 'fetch failed')).toBe(true)
  })

  it('响应体不含 failures 键：5 个源全失败时用户面也拿不到失败信息', async () => {
    // 这里刻意选「全失败」这个场景：旧实现下它正是 `failures` 非空的那种输入，
    // 所以「键不存在」在这个输入上才是有判别力的断言（成功场景本来就没失败可报）。
    const { impl } = fakeFetch(() => new Error('fetch failed'))
    const r = await loadPromptLibrary(store, query, impl)
    // 路由（`api/prompts/route.ts`）把本对象原样交给 `NextResponse.json`，不挑字段，
    // 故断言它等价于断言响应体。
    expect('failures' in r).toBe(false)
    expect(Object.keys(r).sort()).toEqual(['items', 'pending', 'sources', 'tags', 'total'])
    // 失败信息不是被丢弃，只是**换了个面**：管理端仍能逐源读到原文
    const admin = await refreshPromptSources(store, undefined, impl)
    expect(admin.sources.filter((s) => s.id !== BUILT_IN_PROMPT_SOURCE.id).every((s) => s.lastError === 'fetch failed')).toBe(true)
  })
})

describe('抓取与落库', () => {
  it('成功后条目落库、状态列更新、last_error 清空', async () => {
    const { impl } = fakeFetch((url) => payloadFor(url, 3))
    const r = await refreshPromptSources(store, undefined, impl)
    expect(r.summary.successCount).toBe(REMOTE)
    expect(r.summary.total).toBe(REMOTE * 3)
    expect(r.sources.filter((s) => s.id !== BUILT_IN_PROMPT_SOURCE.id).every((s) => s.entryCount === 3 && s.lastError === '' && s.lastSuccessAt)).toBe(true)
  })

  it('失败时旧条目不变、last_success_at 不变，只记原因', async () => {
    const ok = fakeFetch((url) => payloadFor(url, 2))
    await refreshPromptSources(store, undefined, ok.impl)
    const before = fetchableSources()
    expect(before.every((s) => s.entryCount === 2)).toBe(true)

    const bad = fakeFetch(() => new Error('ECONNREFUSED'))
    const r = await refreshPromptSources(store, undefined, bad.impl)
    expect(r.summary.failureCount).toBe(REMOTE)
    const after = fetchableSources()
    expect(after.map((s) => s.entryCount)).toEqual(before.map((s) => s.entryCount))
    expect(after.map((s) => s.lastSuccessAt)).toEqual(before.map((s) => s.lastSuccessAt))
    expect(after.every((s) => s.lastError === 'ECONNREFUSED')).toBe(true)
    // 条目一条没少
    expect(store.listPromptEntries()).toHaveLength(BUILTIN + REMOTE * 2)
  })

  it('返回 HTTP 4xx / 非数组根 / 空数组 都算失败，且不替换旧条目', async () => {
    await refreshPromptSources(store, undefined, fakeFetch((url) => payloadFor(url, 2)).impl)

    for (const [name, body] of [
      ['http', { ok: false, status: 404, json: async () => ({}) }],
      ['not-array', { ok: true, status: 200, json: async () => ({ items: [] }) }],
      ['empty', { ok: true, status: 200, json: async () => [] }],
    ] as const) {
      // 同一分钟内连刷会被频控拦住 —— 这里是测试，逐次清空限流窗口
      resetRateLimiter()
      const impl = (async () => body) as unknown as typeof fetch
      const r = await refreshPromptSources(store, undefined, impl)
      expect(r.summary.failureCount, name).toBe(REMOTE)
      expect(store.listPromptEntries(), name).toHaveLength(BUILTIN + REMOTE * 2)
      const reasons = fetchableSources().map((s) => s.lastError)
      expect(new Set(reasons).size, name).toBe(1)
    }
    expect(fetchableSources()[0].lastError).toBe('未返回任何条目')
  })

  it('超时（TimeoutError）被记成「抓取超时」而不是原始堆栈', async () => {
    const impl = (async () => {
      const e = new Error('The operation was aborted due to timeout')
      e.name = 'TimeoutError'
      throw e
    }) as unknown as typeof fetch
    const r = await refreshPromptSources(store, undefined, impl)
    expect(r.summary.failureCount).toBe(REMOTE)
    expect(fetchableSources()[0].lastError).toBe('抓取超时')
  })

  it('单源失败不影响其它源', async () => {
    const target = REMOTE_PROMPT_SOURCES[0].id
    const { impl } = fakeFetch((url) => (url.includes(target) ? new Error('只坏这一个') : payloadFor(url, 1)))
    const r = await refreshPromptSources(store, undefined, impl)
    expect(r.summary.successCount).toBe(REMOTE - 1)
    expect(r.summary.failureCount).toBe(1)
    expect(r.sources.find((s) => s.id === target)?.lastError).toBe('只坏这一个')
    expect(r.sources.filter((s) => isFetchableSource(s) && s.id !== target).every((s) => s.entryCount === 1)).toBe(true)
  })

  it('只刷新指定源；未知源 id → 400', async () => {
    const { impl, calls } = fakeFetch((url) => payloadFor(url, 1))
    const target = REMOTE_PROMPT_SOURCES[2].id
    const r = await refreshPromptSources(store, target, impl)
    expect(calls).toHaveLength(1)
    expect(r.summary.successCount).toBe(1)
    await expect(refreshPromptSources(store, '不存在的源', impl)).rejects.toThrow(ServiceError)
  })
})

describe('单飞去重', () => {
  it('同一源并发触发两次刷新只发一次网络请求', async () => {
    const calls: string[] = []
    const resolvers: Array<() => void> = []
    const impl = (async (input: string | URL | Request) => {
      calls.push(String(input))
      await new Promise<void>((r) => {
        resolvers.push(r)
      })
      return { ok: true, status: 200, json: async () => payloadFor('x', 1) } as unknown as Response
    }) as unknown as typeof fetch

    const target = REMOTE_PROMPT_SOURCES[0].id
    const a = refreshPromptSources(store, target, impl)
    const b = refreshPromptSources(store, target, impl)
    // 让两个请求都进到 fetch（频控与播种都是同步的）
    await Promise.resolve()
    expect(calls).toHaveLength(1)
    resolvers.forEach((r) => r())
    const [ra, rb] = await Promise.all([a, b])
    expect(ra.summary.total).toBe(1)
    expect(rb.summary.total).toBe(1)
    expect(calls).toHaveLength(1)
  })

  it('惰性刷新与手动刷新共用同一张单飞表', async () => {
    const calls: string[] = []
    const resolvers: Array<() => void> = []
    const impl = (async (input: string | URL | Request) => {
      calls.push(String(input))
      await new Promise<void>((r) => {
        resolvers.push(r)
      })
      return { ok: true, status: 200, json: async () => payloadFor('x', 1) } as unknown as Response
    }) as unknown as typeof fetch

    const target = REMOTE_PROMPT_SOURCES[0].id
    const lazy = loadPromptLibrary(store, query, impl) // 触发全部源的惰性刷新
    const manual = refreshPromptSources(store, target, impl)
    await Promise.resolve()
    // 该源在惰性批次里已有一份在飞，手动刷新不该再发一次
    expect(calls.filter((u) => u.includes(target))).toHaveLength(1)
    for (const release of resolvers) release()
    await Promise.all([lazy, manual])
  })
})

describe('手动刷新与陈旧判定', () => {
  it('手动刷新无条件抓（不受失败重试节奏限制）', async () => {
    const bad = fakeFetch(() => new Error('挂了'))
    await refreshPromptSources(store, undefined, bad.impl)
    const afterFail = fetchableSources()
    expect(afterFail.every((s) => s.lastError === '挂了')).toBe(true)

    // 紧接着再手动刷新一次：仍然真的发了请求（否则失败源 5 分钟内无法人工恢复）
    const good = fakeFetch((url) => payloadFor(url, 1))
    const r = await refreshPromptSources(store, undefined, good.impl)
    expect(good.calls).toHaveLength(REMOTE)
    expect(r.summary.successCount).toBe(REMOTE)
  })

  it('刚抓过的源不会被惰性路径重复抓（成功源 1 小时 TTL）', async () => {
    const { impl, calls } = fakeFetch((url) => payloadFor(url, 1))
    await refreshPromptSources(store, undefined, impl)
    const n = calls.length
    await loadPromptLibrary(store, query, impl)
    await new Promise((r) => setTimeout(r, 20)) // 给「不 await 的后台抓取」一点落地时间
    expect(calls).toHaveLength(n)
  })

  it('失败源在 5 分钟节奏内不会被惰性路径重抓', async () => {
    const { impl, calls } = fakeFetch(() => new Error('挂了'))
    await refreshPromptSources(store, undefined, impl)
    const n = calls.length
    await loadPromptLibrary(store, query, impl)
    await new Promise((r) => setTimeout(r, 20))
    expect(calls).toHaveLength(n)
  })
})

describe('手动刷新的频控', () => {
  it('1 分钟内第 4 次刷新返回 429', async () => {
    const { impl } = fakeFetch((url) => payloadFor(url, 1))
    await refreshPromptSources(store, undefined, impl)
    await refreshPromptSources(store, undefined, impl)
    await refreshPromptSources(store, undefined, impl)
    await expect(refreshPromptSources(store, undefined, impl)).rejects.toThrow(/频繁/)
  })
})

describe('检索结果组装', () => {
  it('分类面只列有内容的源；分面标签来自未应用标签筛选的结果', async () => {
    const { impl } = fakeFetch((url) => (url.includes(REMOTE_PROMPT_SOURCES[0].id) ? payloadFor('a', 3) : []))
    // 第二个源故意返回空 ⇒ 视为失败（不算「有内容」）
    const ok = fakeFetch((url) => (url.includes(REMOTE_PROMPT_SOURCES[0].id) ? payloadFor('a', 3) : payloadFor('b', 0)))
    await refreshPromptSources(store, undefined, ok.impl)

    const all = await loadPromptLibrary(store, { ...query, source: REMOTE_PROMPT_SOURCES[0].name }, impl)
    expect(all.sources.map((s) => s.id)).toEqual([REMOTE_PROMPT_SOURCES[0].id, BUILT_IN_PROMPT_SOURCE.id])

    const tagged = await loadPromptLibrary(store, { ...query, source: REMOTE_PROMPT_SOURCES[0].name, tags: ['标签0'] }, impl)
    expect(tagged.total).toBe(2)
    // 选了「标签0」之后，「标签1」仍在面上（否则用户取消不掉）
    expect(tagged.tags).toEqual(['标签0', '标签1'])
  })

  it('分页与总数一致；越界页返回空数组', async () => {
    const { impl } = fakeFetch((url) => (url.includes(REMOTE_PROMPT_SOURCES[0].id) ? payloadFor('a', 25) : []))
    const ok = fakeFetch((url) => (url.includes(REMOTE_PROMPT_SOURCES[0].id) ? payloadFor('a', 25) : payloadFor('b', 0)))
    await refreshPromptSources(store, undefined, ok.impl)

    const scoped = { ...query, source: REMOTE_PROMPT_SOURCES[0].name }
    const p1 = await loadPromptLibrary(store, { ...scoped, pageSize: 10 }, impl)
    expect(p1.total).toBe(25)
    expect(p1.items).toHaveLength(10)
    const p3 = await loadPromptLibrary(store, { ...scoped, pageSize: 10, page: 3 }, impl)
    expect(p3.items).toHaveLength(5)
    const p9 = await loadPromptLibrary(store, { ...scoped, pageSize: 10, page: 9 }, impl)
    expect(p9.items).toEqual([])
    expect(p9.total).toBe(25)
  })
})

describe('源清单以代码为真相', () => {
  it('播种后全部内置源齐备（含不可抓取的「系统自带」）', async () => {
    const { ensurePromptSources, listPromptSourceStatuses } = await import('@/server/prompts')
    ensurePromptSources(store)
    const statuses = listPromptSourceStatuses(store)
    expect(statuses).toHaveLength(ALL)
    expect(statuses.filter(isFetchableSource).every((s) => s.entryCount === 0 && s.fetchedAt === null && s.lastError === '')).toBe(true)
    // 「系统自带」是本地播种的：条目数 8、从未「抓取」过，但状态列不是空的
    expect(statuses.find((s) => s.id === BUILT_IN_PROMPT_SOURCE.id)).toMatchObject({ entryCount: BUILTIN, lastError: '' })
  })

  it('清单改名后状态列保留（抓取成果不因改代码而丢）', async () => {
    const { impl } = fakeFetch((url) => payloadFor(url, 2))
    await refreshPromptSources(store, undefined, impl)
    const before = store.listPromptSources()[0]
    store.seedPromptSources([{ ...REMOTE_PROMPT_SOURCES[0], name: '改了名' }])
    const after = store.listPromptSources()[0]
    expect(after.name).toBe('改了名')
    expect(after.entryCount).toBe(before.entryCount)
    expect(after.lastSuccessAt).toBe(before.lastSuccessAt)
  })
})

describe('不碰既有数据', () => {
  it('刷新提示词库不写 users / topics / canvas_images / settings', async () => {
    const userId = store.createUser({ name: 'u', email: 'u@e.com', passwordHash: 'x', role: 'user' }).id
    const topicId = store.createTopic(userId, '任务A').id
    const { impl } = fakeFetch((url) => payloadFor(url, 1))
    await refreshPromptSources(store, undefined, impl)
    expect(store.getUserById(userId)?.name).toBe('u')
    expect(store.getTopic(topicId)?.title).toBe('任务A')
    expect(store.listSettings()).toEqual([])
  })
})

describe('外部依赖与超时配置', () => {
  it('抓取带上 8 秒超时信号（用 AbortSignal.timeout，不是裸 fetch）', async () => {
    const seen: Array<AbortSignal | undefined> = []
    const impl = (async (_input: string | URL | Request, init?: RequestInit) => {
      seen.push(init?.signal ?? undefined)
      return { ok: true, status: 200, json: async () => payloadFor('x', 1) } as unknown as Response
    }) as unknown as typeof fetch
    await refreshPromptSources(store, undefined, impl)
    expect(seen).toHaveLength(REMOTE)
    expect(seen.every((s) => s instanceof AbortSignal)).toBe(true)
  })

  it('抓取只请求代码里那 5 个 registry URL（无别的外联）', async () => {
    const { impl, calls } = fakeFetch((url) => payloadFor(url, 1))
    await refreshPromptSources(store, undefined, impl)
    expect(calls).toEqual(REMOTE_PROMPT_SOURCES.map((s) => s.url))
    expect(calls.every((u) => u.startsWith('https://raw.githubusercontent.com/yukkcat/image-prompts/'))).toBe(true)
  })
})

describe('错误原因文案', () => {
  it('原因里不带源名（源名由结果里的 sourceName 单独给，便于管理端按「源名：原因」展示）', async () => {
    const { impl } = fakeFetch(() => ({ items: [] }))
    const r = await refreshPromptSources(store, undefined, impl)
    expect(r.summary.results[0].error).toBe('返回的不是提示词数组')
    expect(r.summary.results[0].error).not.toContain('源')
    expect(r.summary.results[0].sourceName).toBeTruthy()
  })
})

// ---------- 把示例图带进表单 ----------

/** 一个最小的合法 PNG（魔数够 `detectImageMime` 认出来） */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)])

/** 造一条带示例图的提示词（直接落库，跳过抓取） */
function seedEntryWithImages(sourceId: string, entryId: string, images: string[]) {
  store.seedPromptSources([{ id: sourceId, name: `源 ${sourceId}`, url: `https://example.com/${sourceId}.json`, homepage: 'https://example.com' }])
  store.replacePromptEntries(
    sourceId,
    [{ id: entryId, title: '苹果风格海报', prompt: '正文', description: '', coverUrl: images[0] ?? '', referenceImageUrls: images.slice(1), tags: [], author: '', sourceUrl: '' }],
    { signature: 's', now: 'T' }
  )
}

/** 按 URL 决定返回什么的假 fetch；记录每次请求的 url 与 init */
function imageFetch(handler: (url: string, init?: RequestInit) => unknown) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    const out = handler(url, init)
    if (out instanceof Error) throw out
    return out as Response
  }) as unknown as typeof fetch
  return { impl, calls }
}

/** 只看可抓取的源（系统自带的抓取状态列恒为空，不该混进抓取类断言） */
const fetchableSources = () => store.listPromptSources().filter(isFetchableSource)

const pngResponse = (bytes: Buffer = PNG) =>
  ({ ok: true, status: 200, headers: new Headers({ 'content-length': String(bytes.length) }), body: null, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) }) as unknown as Response

/** 流式响应：**故意不带 content-length**，用来验「不能只信声明值」的累计截断 */
const streamResponse = (chunks: Buffer[], headers = new Headers()) =>
  ({
    ok: true,
    status: 200,
    headers,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk))
        controller.close()
      },
      cancel() {},
    }),
  }) as unknown as Response

function newTopic(userId: string, title = '任务A'): string {
  return store.createTopic(userId, title).id
}

describe('把示例图带进表单（attachPromptImage）', () => {
  it('抓下来落成暂存参考：返回 refu_ id、文件落盘、**不进画布**、条目表不受影响', async () => {
    const user = store.createUser({ name: 'u', email: 'u@e.com', passwordHash: 'x', role: 'user' })
    const topicId = newTopic(user.id)
    seedEntryWithImages('src-a', 'e1', ['https://cdn.example.com/cover.png'])
    const before = store.listPromptEntries().length

    const { impl, calls } = imageFetch(() => pngResponse())
    const { reference } = await attachPromptImage(store, dir, user, { topicId, sourceId: 'src-a', entryId: 'e1', index: 0 }, impl)

    expect(reference.id.startsWith('refu_')).toBe(true)
    expect(reference.name).toBe('苹果风格海报')
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://cdn.example.com/cover.png')
    // 落盘 + 只进暂存表
    expect(readdirSync(join(dir, 'storage')).length).toBeGreaterThan(0)
    expect(store.listReferenceUploads(topicId)).toHaveLength(1)
    expect(store.listCanvasImages(topicId)).toHaveLength(0)
    expect(store.listPromptEntries()).toHaveLength(before)
  })

  it('抓的是「服务端库里那条 URL」，客户端只说第几张（index 落在正确的图）', async () => {
    const user = store.createUser({ name: 'u', email: 'u@e.com', passwordHash: 'x', role: 'user' })
    const topicId = newTopic(user.id)
    seedEntryWithImages('src-a', 'e1', ['https://cdn.example.com/cover.png', 'https://cdn.example.com/2.png', 'https://cdn.example.com/3.png'])
    const { impl, calls } = imageFetch(() => pngResponse())
    await attachPromptImage(store, dir, user, { topicId, sourceId: 'src-a', entryId: 'e1', index: 2 }, impl)
    expect(calls[0].url).toBe('https://cdn.example.com/3.png')
  })

  it('安全闸生效：条目里的内网 URL 直接 400，**一个请求都不发**', async () => {
    const user = store.createUser({ name: 'u', email: 'u@e.com', passwordHash: 'x', role: 'user' })
    const topicId = newTopic(user.id)
    seedEntryWithImages('src-a', 'e1', ['http://127.0.0.1:3100/api/auth/me'])
    const { impl, calls } = imageFetch(() => pngResponse())
    await expect(attachPromptImage(store, dir, user, { topicId, sourceId: 'src-a', entryId: 'e1', index: 0 }, impl)).rejects.toThrow(/地址不可用/)
    expect(calls).toHaveLength(0)
    expect(store.listReferenceUploads(topicId)).toHaveLength(0)
  })

  it('跳转逐跳复检：第一跳合法、第二跳跳内网 ⇒ 拒绝且不发第二次请求', async () => {
    const user = store.createUser({ name: 'u', email: 'u@e.com', passwordHash: 'x', role: 'user' })
    const topicId = newTopic(user.id)
    seedEntryWithImages('src-a', 'e1', ['https://cdn.example.com/cover.png'])
    const { impl, calls } = imageFetch(
      () => ({ ok: false, status: 302, headers: new Headers({ location: 'http://169.254.169.254/latest/meta-data/' }), body: null }) as unknown as Response
    )
    await expect(attachPromptImage(store, dir, user, { topicId, sourceId: 'src-a', entryId: 'e1', index: 0 }, impl)).rejects.toThrow(/地址不可用/)
    expect(calls).toHaveLength(1)
  })

  it('跳转一次后成功：跟随合法跳转', async () => {
    const user = store.createUser({ name: 'u', email: 'u@e.com', passwordHash: 'x', role: 'user' })
    const topicId = newTopic(user.id)
    seedEntryWithImages('src-a', 'e1', ['https://cdn.example.com/cover.png'])
    const { impl, calls } = imageFetch((url) =>
      url === 'https://cdn.example.com/cover.png'
        ? ({ ok: false, status: 301, headers: new Headers({ location: 'https://cdn2.example.com/real.png' }), body: null } as unknown as Response)
        : pngResponse()
    )
    const { reference } = await attachPromptImage(store, dir, user, { topicId, sourceId: 'src-a', entryId: 'e1', index: 0 }, impl)
    expect(reference.id.startsWith('refu_')).toBe(true)
    expect(calls.map((c) => c.url)).toEqual(['https://cdn.example.com/cover.png', 'https://cdn2.example.com/real.png'])
  })

  it('跳转次数超上限 ⇒ 502（每一跳都发请求，但不会无限跟）', async () => {
    const user = store.createUser({ name: 'u', email: 'u@e.com', passwordHash: 'x', role: 'user' })
    const topicId = newTopic(user.id)
    seedEntryWithImages('src-a', 'e1', ['https://cdn.example.com/cover.png'])
    const { impl, calls } = imageFetch(
      () => ({ ok: false, status: 302, headers: new Headers({ location: 'https://cdn.example.com/next.png' }), body: null }) as unknown as Response
    )
    await expect(attachPromptImage(store, dir, user, { topicId, sourceId: 'src-a', entryId: 'e1', index: 0 }, impl)).rejects.toThrow(/跳转次数过多/)
    expect(calls).toHaveLength(3) // 首跳 + 2 次跟随
  })

  it('跳转目标解析不出 URL ⇒ 502 跳转不合法', async () => {
    const user = store.createUser({ name: 'u', email: 'u@e.com', passwordHash: 'x', role: 'user' })
    const topicId = newTopic(user.id)
    seedEntryWithImages('src-a', 'e1', ['https://cdn.example.com/cover.png'])
    const { impl } = imageFetch(
      () => ({ ok: false, status: 302, headers: new Headers({ location: 'http://[' }), body: null }) as unknown as Response
    )
    await expect(attachPromptImage(store, dir, user, { topicId, sourceId: 'src-a', entryId: 'e1', index: 0 }, impl)).rejects.toThrow(/跳转不合法/)
  })

  it('没有 content-length 且流式累计超 10MB ⇒ 413（声明值可以缺失或撒谎）', async () => {
    const user = store.createUser({ name: 'u', email: 'u@e.com', passwordHash: 'x', role: 'user' })
    const topicId = newTopic(user.id)
    seedEntryWithImages('src-a', 'e1', ['https://cdn.example.com/cover.png'])
    const { impl } = imageFetch(() => streamResponse([Buffer.alloc(6 * 1024 * 1024), Buffer.alloc(6 * 1024 * 1024)]))
    await expect(attachPromptImage(store, dir, user, { topicId, sourceId: 'src-a', entryId: 'e1', index: 0 }, impl)).rejects.toThrow(/超过 10MB/)
    expect(store.listReferenceUploads(topicId)).toHaveLength(0)
  })

  it('没有 content-length 但流式在限额内 ⇒ 正常落盘', async () => {
    const user = store.createUser({ name: 'u', email: 'u@e.com', passwordHash: 'x', role: 'user' })
    const topicId = newTopic(user.id)
    seedEntryWithImages('src-a', 'e1', ['https://cdn.example.com/cover.png'])
    const { impl } = imageFetch(() => streamResponse([PNG.subarray(0, 10), PNG.subarray(10)]))
    const { reference } = await attachPromptImage(store, dir, user, { topicId, sourceId: 'src-a', entryId: 'e1', index: 0 }, impl)
    expect(reference.id.startsWith('refu_')).toBe(true)
  })

  it('非 2xx ⇒ 502 带状态码；不落盘不留行', async () => {
    const user = store.createUser({ name: 'u', email: 'u@e.com', passwordHash: 'x', role: 'user' })
    const topicId = newTopic(user.id)
    seedEntryWithImages('src-a', 'e1', ['https://cdn.example.com/cover.png'])
    const { impl } = imageFetch(() => ({ ok: false, status: 503, headers: new Headers(), body: null }) as unknown as Response)
    await expect(attachPromptImage(store, dir, user, { topicId, sourceId: 'src-a', entryId: 'e1', index: 0 }, impl)).rejects.toThrow(/HTTP 503/)
    expect(store.listReferenceUploads(topicId)).toHaveLength(0)
  })

  it('不是图片（魔数不过）⇒ 415，且不落盘不留行', async () => {
    const user = store.createUser({ name: 'u', email: 'u@e.com', passwordHash: 'x', role: 'user' })
    const topicId = newTopic(user.id)
    seedEntryWithImages('src-a', 'e1', ['https://cdn.example.com/cover.png'])
    const { impl } = imageFetch(() => pngResponse(Buffer.from('<!doctype html><html>…')))
    await expect(attachPromptImage(store, dir, user, { topicId, sourceId: 'src-a', entryId: 'e1', index: 0 }, impl)).rejects.toThrow(/不是可用的图片格式/)
    expect(store.listReferenceUploads(topicId)).toHaveLength(0)
  })

  it('超过 10MB ⇒ 413（看 content-length，不看内容）', async () => {
    const user = store.createUser({ name: 'u', email: 'u@e.com', passwordHash: 'x', role: 'user' })
    const topicId = newTopic(user.id)
    seedEntryWithImages('src-a', 'e1', ['https://cdn.example.com/cover.png'])
    const { impl } = imageFetch(
      () => ({ ok: true, status: 200, headers: new Headers({ 'content-length': String(11 * 1024 * 1024) }), body: null, arrayBuffer: async () => new ArrayBuffer(0) }) as unknown as Response
    )
    await expect(attachPromptImage(store, dir, user, { topicId, sourceId: 'src-a', entryId: 'e1', index: 0 }, impl)).rejects.toThrow(/超过 10MB/)
    expect(store.listReferenceUploads(topicId)).toHaveLength(0)
  })

  it('超时 ⇒ 504（不把原始堆栈抛给页面）', async () => {
    const user = store.createUser({ name: 'u', email: 'u@e.com', passwordHash: 'x', role: 'user' })
    const topicId = newTopic(user.id)
    seedEntryWithImages('src-a', 'e1', ['https://cdn.example.com/cover.png'])
    const { impl } = imageFetch(() => {
      const e = new Error('timeout')
      e.name = 'TimeoutError'
      return e
    })
    await expect(attachPromptImage(store, dir, user, { topicId, sourceId: 'src-a', entryId: 'e1', index: 0 }, impl)).rejects.toThrow(/抓取超时/)
  })

  it('任务不属于当前用户 ⇒ 404，且不发请求', async () => {
    const owner = store.createUser({ name: 'owner', email: 'o@e.com', passwordHash: 'x', role: 'user' })
    const other = store.createUser({ name: 'other', email: 't@e.com', passwordHash: 'x', role: 'user' })
    const topicId = newTopic(owner.id)
    seedEntryWithImages('src-a', 'e1', ['https://cdn.example.com/cover.png'])
    const { impl, calls } = imageFetch(() => pngResponse())
    await expect(attachPromptImage(store, dir, other, { topicId, sourceId: 'src-a', entryId: 'e1', index: 0 }, impl)).rejects.toThrow(/任务不存在/)
    expect(calls).toHaveLength(0)
  })

  it('条目不存在 / 下标越界 / 该条没有图 ⇒ 各自的 4xx，都不发请求', async () => {
    const user = store.createUser({ name: 'u', email: 'u@e.com', passwordHash: 'x', role: 'user' })
    const topicId = newTopic(user.id)
    seedEntryWithImages('src-a', 'e1', ['https://cdn.example.com/cover.png'])
    // ⚠️ seedPromptSources 是「同步清单」：不在清单里的源会被删掉，所以两个源要一起给
    store.seedPromptSources([
      { id: 'src-a', name: '源 A', url: 'https://example.com/a.json', homepage: 'https://example.com' },
      { id: 'src-b', name: '源 B', url: 'https://example.com/b.json', homepage: 'https://example.com' },
    ])
    store.replacePromptEntries('src-b', [{ id: 'e2', title: '无图', prompt: 'p', description: '', coverUrl: '', referenceImageUrls: [], tags: [], author: '', sourceUrl: '' }], { signature: 's', now: 'T' })

    const { impl, calls } = imageFetch(() => pngResponse())
    await expect(attachPromptImage(store, dir, user, { topicId, sourceId: 'src-a', entryId: '不存在', index: 0 }, impl)).rejects.toThrow(/已不在库里/)
    await expect(attachPromptImage(store, dir, user, { topicId, sourceId: 'src-a', entryId: 'e1', index: 5 }, impl)).rejects.toThrow(/没有可用的示例图/)
    await expect(attachPromptImage(store, dir, user, { topicId, sourceId: 'src-b', entryId: 'e2', index: 0 }, impl)).rejects.toThrow(/没有可用的示例图/)
    expect(calls).toHaveLength(0)
  })

  it('不碰既有数据：提示词库、画布图、其它任务都不受影响', async () => {
    const user = store.createUser({ name: 'u', email: 'u@e.com', passwordHash: 'x', role: 'user' })
    const topicA = newTopic(user.id, 'A')
    const topicB = newTopic(user.id, 'B')
    seedEntryWithImages('src-a', 'e1', ['https://cdn.example.com/cover.png'])
    const { impl } = imageFetch(() => pngResponse())
    await attachPromptImage(store, dir, user, { topicId: topicA, sourceId: 'src-a', entryId: 'e1', index: 0 }, impl)
    expect(store.listReferenceUploads(topicA)).toHaveLength(1)
    expect(store.listReferenceUploads(topicB)).toHaveLength(0)
    expect(store.listSettings()).toEqual([])
  })

  it('抓取带 8 秒超时信号与手动跳转模式', async () => {
    const user = store.createUser({ name: 'u', email: 'u@e.com', passwordHash: 'x', role: 'user' })
    const topicId = newTopic(user.id)
    seedEntryWithImages('src-a', 'e1', ['https://cdn.example.com/cover.png'])
    const { impl, calls } = imageFetch(() => pngResponse())
    await attachPromptImage(store, dir, user, { topicId, sourceId: 'src-a', entryId: 'e1', index: 0 }, impl)
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal)
    expect(calls[0].init?.redirect).toBe('manual')
  })

  it('落盘文件确实写到了数据目录（不是只插了一行）', async () => {
    const user = store.createUser({ name: 'u', email: 'u@e.com', passwordHash: 'x', role: 'user' })
    const topicId = newTopic(user.id)
    seedEntryWithImages('src-a', 'e1', ['https://cdn.example.com/cover.png'])
    const { impl } = imageFetch(() => pngResponse())
    const { reference } = await attachPromptImage(store, dir, user, { topicId, sourceId: 'src-a', entryId: 'e1', index: 0 }, impl)
    const rows = store.listReferenceUploads(topicId)
    expect(rows[0].id).toBe(reference.id)
    // storagePathFor 的路径规则：dataDir/storage/<imageKey>
    expect(existsSync(join(dir, 'storage'))).toBe(true)
  })
})

describe('「系统自带」源（模板并入）', () => {
  it('读一次库就把它播种好：8 条模板、图是站内静态资源、**一个网络请求都不发**', async () => {
    const { impl, calls } = imageFetch(() => pngResponse())
    const r = await loadPromptLibrary(store, query, impl)
    const builtinItems = r.items.filter((i) => i.sourceId === BUILT_IN_PROMPT_SOURCE.id)
    expect(builtinItems).toHaveLength(BUILTIN)
    expect(builtinItems.every((i) => i.images[0] === `/templates/${i.id}.jpg`)).toBe(true)
    // 站内静态图也能带进参考图（逐张判，与服务端 attach 前的判定同一份纯函数）
    expect(builtinItems.every((i) => i.images.every((url) => isAttachableImage(url)))).toBe(true)
    // 不可抓取的源不进抓取目标：没有任何请求打到空地址
    expect(calls.every((c) => c.url.startsWith('https://'))).toBe(true)
    expect(calls.every((c) => c.url !== '')).toBe(true)
  })

  it('内容指纹没变时不重播（第二次读不再写库）', async () => {
    const { impl } = fakeFetch(() => payloadFor('x', 1))
    await loadPromptLibrary(store, query, impl)
    const sig1 = store.listPromptSources().find((s) => s.id === BUILT_IN_PROMPT_SOURCE.id)?.signature
    await loadPromptLibrary(store, query, impl)
    expect(store.listPromptSources().find((s) => s.id === BUILT_IN_PROMPT_SOURCE.id)?.signature).toBe(sig1)
    expect(store.listPromptEntries().filter((e) => e.sourceId === BUILT_IN_PROMPT_SOURCE.id)).toHaveLength(BUILTIN)
  })

  it('按来源筛选能只列系统自带；按标签也能命中', async () => {
    const { impl } = fakeFetch(() => payloadFor('x', 1))
    const bySource = await loadPromptLibrary(store, { ...query, source: BUILT_IN_PROMPT_SOURCE.name }, impl)
    expect(bySource.total).toBe(BUILTIN)
    expect(bySource.sources.map((s) => s.id)).toEqual([BUILT_IN_PROMPT_SOURCE.id])
    const byTag = await loadPromptLibrary(store, { ...query, tags: ['商品'] }, impl)
    expect(byTag.total).toBe(1)
  })
})

describe('示例图的可带性判定', () => {
  it('isSafePublicAssetPath：只放行站内静态图片，挡路径穿越与协议前缀', () => {
    for (const ok of ['/templates/a.jpg', '/templates/a.jpeg', '/templates/a.png', '/templates/a.webp', '/x/y/z.JPG']) {
      expect(isSafePublicAssetPath(ok), ok).toBe(true)
    }
    for (const bad of [
      'templates/a.jpg', // 相对路径
      '//evil.com/a.jpg',
      '/../etc/passwd',
      '/templates/../../etc/passwd.jpg',
      '/templates/a.jpg?x=1',
      'http://evil.com/a.jpg',
      'file:///etc/passwd',
      'data:image/png;base64,AAAA',
      '/templates/a.txt',
      '/templates/a.jpg%00.png',
      '/templates\\a.jpg',
    ]) {
      expect(isSafePublicAssetPath(bad), bad).toBe(false)
    }
  })

  it('isAttachableImage：远程可抓图与站内静态图可带，其它不行', () => {
    expect(isAttachableImage('https://cdn.example.com/a.png')).toBe(true)
    expect(isAttachableImage('/templates/a.jpg')).toBe(true)
    expect(isAttachableImage('http://127.0.0.1/a.png')).toBe(false)
    expect(isAttachableImage('data:image/png;base64,AAAA')).toBe(false)
    expect(isAttachableImage('')).toBe(false)
  })
})

describe('把「系统自带」的模板图带进表单（本地静态资源，不联网）', () => {
  it('直接读 public 下的文件落成暂存参考，一个请求都不发', async () => {
    const user = store.createUser({ name: 'u', email: 'u@e.com', passwordHash: 'x', role: 'user' })
    const topicId = newTopic(user.id)
    const { impl } = fakeFetch(() => payloadFor('x', 1))
    await loadPromptLibrary(store, query, impl) // 播种系统自带
    const first = BUILT_IN_PROMPT_ENTRIES[0]
    const callsBefore = 0
    const net = fakeFetch(() => pngResponse())
    const { reference } = await attachPromptImage(
      store,
      dir,
      user,
      { topicId, sourceId: BUILT_IN_PROMPT_SOURCE.id, entryId: first.id, index: 0 },
      net.impl
    )
    expect(net.calls).toHaveLength(callsBefore)
    expect(reference.id.startsWith('refu_')).toBe(true)
    expect(reference.name).toBe(first.title)
    expect(reference.mimeType).toBe('image/jpeg') // 真读了 public/templates/*.jpg
    expect(store.listReferenceUploads(topicId)).toHaveLength(1)
    expect(store.listCanvasImages(topicId)).toHaveLength(0)
  })

  it('静态资源文件不存在 ⇒ 404（不落行）', async () => {
    const user = store.createUser({ name: 'u', email: 'u@e.com', passwordHash: 'x', role: 'user' })
    const topicId = newTopic(user.id)
    store.seedPromptSources([{ id: 'src-z', name: '源 Z', url: 'https://example.com/z.json', homepage: '' }])
    store.replacePromptEntries('src-z', [{ id: 'e1', title: '缺图', prompt: 'p', description: '', coverUrl: '/templates/does-not-exist.jpg', referenceImageUrls: [], tags: [], author: '', sourceUrl: '' }], { signature: 's', now: 'T' })
    const net = fakeFetch(() => pngResponse())
    await expect(attachPromptImage(store, dir, user, { topicId, sourceId: 'src-z', entryId: 'e1', index: 0 }, net.impl)).rejects.toThrow(/文件不存在/)
    expect(net.calls).toHaveLength(0)
    expect(store.listReferenceUploads(topicId)).toHaveLength(0)
  })
})
