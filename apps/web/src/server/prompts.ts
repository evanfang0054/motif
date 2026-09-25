/**
 * 提示词库的服务端代理：抓上游 → 落库 → 读库。
 *
 * 为什么在服务端抓（而不是像上游那样浏览器直连）：
 * 1. 浏览器直连境外域名不稳，且会把用户 IP 暴露给第三方 CDN；
 * 2. Motif 是「服务端权威 + 多租户」，缓存落库才能被多端共享、被管理后台观测；
 * 3. 抓取与解析的失败必须可观测（状态列 + 审计），浏览器侧做不到。
 *
 * 两条与上游不同的取舍：
 * - **首次打开不阻塞**：库里没内容时也立刻返回（`pending: true`），抓取在后台跑，
 *   前端轮询。上游阻塞等待，而服务端一次要抓 5 个源、每源上限 8 秒，让人干等不合适。
 * - **失败源 5 分钟内不重试**：见 `isSourceStale` 的注释。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { detectImageMime, type StagedReference, type User } from '@motif/core'
import type { MotifStore, PromptEntryRow, PromptSourceRow } from '@motif/db'
import { zhReason } from '@/lib/error-message'
import { BUILT_IN_PROMPT_ENTRIES, BUILT_IN_PROMPT_SOURCE } from '@/lib/prompt-builtins'
import { BUILT_IN_PROMPT_SOURCES, PROMPT_ATTACH_TIMEOUT_MS, PROMPT_FETCH_TIMEOUT_MS, isFetchableSource, type PromptSourceDef } from '@/lib/prompt-sources'
import {
  collectPromptTags,
  filterPromptEntries,
  isSafePublicAssetPath,
  isSafeRemoteImageUrl,
  isSourceStale,
  paginatePromptEntries,
  parsePromptSourcePayload,
  promptEntryImages,
  sourceSignature,
  type PromptQuery,
} from '@/lib/prompts'
import { checkRate } from './rate-limit'
/**
 * ⚠️ 本文件里对 `node:fs` 的直读**不在图片存储驱动的改造范围内**：
 * 读的是 `public/` 下随仓库分发的**提示词库示例图**（静态资源），不是用户上传/生成的图片。
 * 用户图片一律走 `server/storage.ts` 的分派层（支持 local/s3 双读）。
 */
import { saveReferenceImage, ServiceError } from './services'

export { parsePromptQuery } from '@/lib/prompts'
// 安全闸是纯函数、与「这张图能不能带进参考图」的判断共用一份实现（前端也 import 它）：
// 服务端这边只做转发，避免两边各写一份而漂移。
export { isAttachableImage, isSafePublicAssetPath } from '@/lib/prompts'
export type { PromptQuery } from '@/lib/prompts'

/** 管理页要看的逐源状态 */
export interface PromptSourceStatus {
  id: string
  name: string
  url: string
  homepage: string
  entryCount: number
  fetchedAt: string | null
  lastSuccessAt: string | null
  lastError: string
}

export interface PromptSourceRefreshResult {
  sourceId: string
  sourceName: string
  count: number
  success: boolean
  error: string
}

export interface PromptSourceRefreshSummary {
  results: PromptSourceRefreshResult[]
  total: number
  successCount: number
  failureCount: number
}

/** 响应里的条目 = 库里的行 + 服务端算好的示例图列表 */
export type PromptLibraryItem = PromptEntryRow & {
  /** 封面在前、去重丢空、上限 7；「点第 N 张」的 index 就是它的下标 */
  images: string[]
}

export interface PromptLibraryResult {
  items: PromptLibraryItem[]
  total: number
  tags: string[]
  sources: Array<{ id: string; name: string; homepage: string; entryCount: number }>
  /** 是否仍有陈旧的可抓取源正在后台抓取 —— 前端据此显示加载态并轮询 */
  pending: boolean
}

/** 「系统自带」条目的指纹：内容改了就会变，用来判断要不要重播（复用 signature 列） */
function builtinEntriesSignature(): string {
  return sourceSignature({
    name: BUILT_IN_PROMPT_SOURCE.name,
    url: `${BUILT_IN_PROMPT_SOURCE.id}#${JSON.stringify(BUILT_IN_PROMPT_ENTRIES)}`,
    homepage: BUILT_IN_PROMPT_SOURCE.homepage,
  })
}

/**
 * 源清单的真相在代码里；每次读库前同步一次（幂等）：
 * 1. 按清单 upsert（只覆盖清单列、抓取状态保留），并**删掉不在清单里的源**（连同条目）；
 * 2. 「系统自带」是**本地播种**的源（`url` 为空、不可抓取）：条目内容指纹变了才重播，
 *    平时一次写都不做。
 */
export function ensurePromptSources(store: MotifStore): void {
  store.seedPromptSources(BUILT_IN_PROMPT_SOURCES)
  const builtin = store.listPromptSources().find((s) => s.id === BUILT_IN_PROMPT_SOURCE.id)
  const signature = builtinEntriesSignature()
  if (builtin && builtin.signature === signature && builtin.entryCount === BUILT_IN_PROMPT_ENTRIES.length) return
  store.replacePromptEntries(BUILT_IN_PROMPT_SOURCE.id, BUILT_IN_PROMPT_ENTRIES, { signature, now: new Date().toISOString() })
}

export function listPromptSourceStatuses(store: MotifStore): PromptSourceStatus[] {
  return store.listPromptSources().map(toStatus)
}

function toStatus(row: PromptSourceRow): PromptSourceStatus {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    homepage: row.homepage,
    entryCount: row.entryCount,
    fetchedAt: row.fetchedAt,
    lastSuccessAt: row.lastSuccessAt,
    lastError: row.lastError,
  }
}

/** 把底层异常翻译成给运维看的一句话（**不带源名** —— 源名由结果里的 sourceName 单独给） */
function describeReason(e: unknown): string {
  if (e instanceof Error) {
    if (e.name === 'TimeoutError') return '抓取超时'
    if (e.name === 'AbortError') return '抓取被中断'
    if (e instanceof SyntaxError) return '返回的不是合法 JSON'
    return e.message
  }
  return String(e)
}

/**
 * 单飞去重：同一个源正在抓时复用同一个 Promise。
 * 惰性刷新与管理后台手动刷新共用这张表 —— 手动点刷新恰好撞上后台抓取时不该发第二次请求。
 */
const inFlight = new Map<string, Promise<PromptSourceRefreshResult>>()

async function doRefreshSource(
  store: MotifStore,
  def: PromptSourceDef,
  fetchImpl: typeof fetch
): Promise<PromptSourceRefreshResult> {
  const signature = sourceSignature(def)
  try {
    const res = await fetchImpl(def.url, {
      cache: 'no-store',
      signal: AbortSignal.timeout(PROMPT_FETCH_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`返回 HTTP ${res.status}`)
    const entries = parsePromptSourcePayload(await res.json(), def)
    // 内置源解析出 0 条视为失败（照抄上游）：一次「合法的空数组」若当成成功，
    // 会把该源的好缓存清空，且此后每次打开都会因为「库空」再抓一次。
    if (entries.length === 0) throw new Error('未返回任何条目')
    store.replacePromptEntries(def.id, entries, { signature, now: new Date().toISOString() })
    return { sourceId: def.id, sourceName: def.name, count: entries.length, success: true, error: '' }
  } catch (e) {
    const reason = describeReason(e)
    store.recordPromptSourceFailure(def.id, reason, new Date().toISOString(), signature)
    return { sourceId: def.id, sourceName: def.name, count: 0, success: false, error: reason }
  }
}

function refreshOneSource(
  store: MotifStore,
  def: PromptSourceDef,
  fetchImpl: typeof fetch
): Promise<PromptSourceRefreshResult> {
  const running = inFlight.get(def.id)
  if (running) return running
  const task = doRefreshSource(store, def, fetchImpl).finally(() => inFlight.delete(def.id))
  inFlight.set(def.id, task)
  return task
}

async function refreshSources(
  store: MotifStore,
  defs: readonly PromptSourceDef[],
  fetchImpl: typeof fetch
): Promise<PromptSourceRefreshSummary> {
  const results = await Promise.all(defs.map((def) => refreshOneSource(store, def, fetchImpl)))
  return {
    results,
    total: results.reduce((sum, r) => sum + r.count, 0),
    successCount: results.filter((r) => r.success).length,
    failureCount: results.filter((r) => !r.success).length,
  }
}

function assemble(
  entries: readonly PromptEntryRow[],
  sources: readonly PromptSourceRow[],
  query: PromptQuery,
  pending: boolean
): PromptLibraryResult {
  const filtered = filterPromptEntries(entries, { keyword: query.keyword, tags: query.tags, source: query.source })
  // 标签面在「应用了关键词与来源、但**未应用标签**」的结果上收集：
  // 否则一旦选了某个标签，其它标签会从面上消失，用户就取消不掉了（照抄上游）。
  const facetBase = filterPromptEntries(entries, { keyword: query.keyword, tags: [], source: query.source })
  return {
    items: paginatePromptEntries(filtered, query.page, query.pageSize).map((e) => ({ ...e, images: promptEntryImages(e) })),
    total: filtered.length,
    tags: collectPromptTags(facetBase),
    sources: sources
      .filter((s) => s.entryCount > 0)
      .map((s) => ({ id: s.id, name: s.name, homepage: s.homepage, entryCount: s.entryCount })),
    // ⚠️ 这里**刻意不返回**各源的抓取失败原因（`lastError`）：那是**运维口径**的信息，
    // 只在管理端「系统设置 → 提示词库」的「上次错误」列展示原文。用户侧看不到失败态，
    // 失败时静默降级为「展示上次成功的内容」或「还没有内容」。
    pending,
  }
}

/**
 * 读库 + 惰性刷新。**任何路径都不等待外网** —— 陈旧源在后台抓，本次请求立刻返回库里的内容。
 * 只要有陈旧的可抓取源在后台抓，就返回 `pending: true`，前端据此显示加载态并轮询
 * （而不是把「正在抓」当成「拉不到」）。
 */
export async function loadPromptLibrary(
  store: MotifStore,
  query: PromptQuery,
  fetchImpl: typeof fetch = fetch
): Promise<PromptLibraryResult> {
  ensurePromptSources(store)
  const sources = store.listPromptSources()
  const entries = store.listPromptEntries()
  const now = Date.now()
  const stale = sources.filter(
    (s) => isFetchableSource(s) && isSourceStale({ fetchedAt: s.fetchedAt, signature: s.signature, lastError: s.lastError, def: s, now })
  )
  if (stale.length > 0) {
    // 故意不 await、也故意不抛：抓取失败只落 last_error，不影响本次返回的内容
    void refreshSources(store, stale, fetchImpl).catch(() => {})
  }
  // `pending` = 「还有可抓取的陈旧源正在后台抓」。⚠️ 不再看「库里有没有内容」：
  // 有了「系统自带」这个本地播种的源之后，库里**永不为空**，按旧口径 pending 恒为 false，
  // 前端就不会再轮询、外部源的首抓结果要等下次打开才出现。
  return assemble(entries, sources, query, stale.length > 0)
}

/**
 * 手动刷新（管理后台）。**无条件抓**，不受 `isSourceStale` 限制 ——
 * 失败源在 5 分钟节奏内不会自动重试，这是它唯一的人工恢复路径。
 *
 * 先播种再抓：`prompt_entries.source_id` 是指向 `prompt_sources` 的外键
 * （且 `foreign_keys = ON`），新库若没播种，写条目会撞外键。
 *
 * 频控放在这里（与既有「测试发送」一致：动作型接口的频控在 service 层）。
 * ⚠️ 频控键是**全局单键**（不像测试发送按收件人建键）：这里要保护的是「上游那 5 个源」，
 * 它是全站共享资源 —— 无论谁点，都不该让同一个源在一分钟内被敲第四次。
 */
export async function refreshPromptSources(
  store: MotifStore,
  sourceId?: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ summary: PromptSourceRefreshSummary; sources: PromptSourceStatus[] }> {
  ensurePromptSources(store)
  const all = store.listPromptSources()
  // 不可抓取的源（系统自带）不进抓取目标：空地址 fetch 只会白记一条错误
  const fetchable = all.filter(isFetchableSource)
  const targets = sourceId ? fetchable.filter((s) => s.id === sourceId) : fetchable
  if (sourceId && targets.length === 0) throw new ServiceError(400, '提示词源不存在。')
  if (!checkRate('prompts:refresh', 60_000, 3)) throw new ServiceError(429, '刷新过于频繁，请 1 分钟后再试。')
  const summary = await refreshSources(store, targets, fetchImpl)
  return { summary, sources: listPromptSourceStatuses(store) }
}

// ---------- 把示例图带进表单 ----------

/** 示例图抓取上限，与上传参考图同口径（10MB） */
const ATTACH_MAX_BYTES = 10 * 1024 * 1024
/** 示例图允许的跳转次数；**每一跳都复检安全闸**（只查第一跳挡不住「第一跳合法、第二跳跳内网」） */
const ATTACH_MAX_REDIRECTS = 2

/** 流式读并按上限截断：`content-length` 可能缺失或撒谎，不能只信它 */
async function readCapped(res: Response, max: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > max) throw new ServiceError(413, '示例图超过 10MB。')
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > max) throw new ServiceError(413, '示例图超过 10MB。')
    return buf
  }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > max) {
      await reader.cancel()
      throw new ServiceError(413, '示例图超过 10MB。')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

/** 手动跟随跳转：每跳都过 `isSafeRemoteImageUrl`，跳太多就放弃 */
async function fetchImageFollowingSafeRedirects(url: string, fetchImpl: typeof fetch): Promise<Response> {
  let current = url
  for (let hop = 0; hop <= ATTACH_MAX_REDIRECTS; hop += 1) {
    const res = await fetchImpl(current, { redirect: 'manual', signal: AbortSignal.timeout(PROMPT_ATTACH_TIMEOUT_MS) })
    if (res.status < 300 || res.status >= 400) return res
    const location = res.headers.get('location')
    if (!location) return res
    let next: string
    try {
      next = new URL(location, current).toString()
    } catch {
      throw new ServiceError(502, '示例图地址跳转不合法。')
    }
    if (!isSafeRemoteImageUrl(next)) throw new ServiceError(400, '示例图地址不可用。')
    current = next
  }
  throw new ServiceError(502, '示例图地址跳转次数过多。')
}

/**
 * 把某条提示词的示例图变成**暂存参考**（`refu_`，不进画布）。
 *
 * 三条刻意的设计：
 * 1. **URL 由服务端从自己的库里取**（按 `sourceId + entryId` 查 `prompt_entries`），
 *    客户端只传「第几张」—— 否则服务端就成了任意 URL 的 SSRF 跳板。
 * 2. **落库复用 `saveReferenceImage`**（与上传同一条路径：校验任务归属、写文件、
 *    只入 `reference_uploads`），不另写一套落盘逻辑。
 * 3. **上限不在服务端判**：与上传同口径 —— 那一刻服务端读不到客户端侧的画布引用，
 *    独立上限会是死代码；真正的兜底在 `enqueueGeneration`。
 */
export async function attachPromptImage(
  store: MotifStore,
  dataDir: string,
  user: User,
  input: { topicId: string; sourceId: string; entryId: string; index: number },
  fetchImpl: typeof fetch = fetch
): Promise<{ reference: StagedReference }> {
  const topic = store.getTopic(input.topicId)
  if (!topic || topic.userId !== user.id) throw new ServiceError(404, '任务不存在。')
  const entry = store.listPromptEntries().find((e) => e.sourceId === input.sourceId && e.id === input.entryId)
  if (!entry) throw new ServiceError(404, '这条提示词已不在库里，请重新打开提示词库。')
  const url = promptEntryImages(entry)[input.index]
  if (!url) throw new ServiceError(400, '这条提示词没有可用的示例图。')

  // 站内静态资源（系统自带模板的预览图）：直接读 `public/` 下的文件，不联网。
  // 白名单挡住 `..` / 反斜杠 / 协议前缀，避免被当成任意文件读取。
  if (isSafePublicAssetPath(url)) {
    const abs = join(process.cwd(), 'public', url.replace(/^\/+/, ''))
    if (!existsSync(abs)) throw new ServiceError(404, '示例图文件不存在。')
    const localBuffer = readFileSync(abs)
    const localMime = detectImageMime(localBuffer)
    if (!localMime) throw new ServiceError(415, '示例图不是可用的图片格式。')
    return { reference: await saveReferenceImage(store, dataDir, user, input.topicId, { buffer: localBuffer, mimeType: localMime, name: entry.title }) }
  }
  if (!isSafeRemoteImageUrl(url)) throw new ServiceError(400, '示例图地址不可用。')

  let res: Response
  try {
    res = await fetchImageFollowingSafeRedirects(url, fetchImpl)
  } catch (e) {
    if (e instanceof ServiceError) throw e
    if (e instanceof Error && e.name === 'TimeoutError') throw new ServiceError(504, '示例图抓取超时，请稍后再试。')
    // 底层异常名（undici 的 `fetch failed`、DNS 的 ENOTFOUND…）对用户毫无意义 —— 经 zhReason 收口成中文。
    // 原始原因不丢：这条路径不落库（没有可写的状态列），故当场记服务端日志，排障口径与
    // refreshPromptSources 记进 lastError 的那份一致。
    const raw = e instanceof Error ? e.message : String(e)
    console.warn('[motif] 示例图抓取失败（用户端已收口为中文）:', raw)
    throw new ServiceError(502, `示例图抓取失败：${zhReason(raw, '未知错误')}`)
  }
  if (!res.ok) throw new ServiceError(502, `示例图抓取失败：HTTP ${res.status}`)

  const buffer = await readCapped(res, ATTACH_MAX_BYTES)
  const mime = detectImageMime(buffer)
  if (!mime) throw new ServiceError(415, '示例图不是可用的图片格式。')
  return { reference: await saveReferenceImage(store, dataDir, user, input.topicId, { buffer, mimeType: mime, name: entry.title }) }
}
