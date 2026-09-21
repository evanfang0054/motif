/**
 * 提示词库的纯函数层：解析、签名、陈旧判定、筛选、分面、分页。
 *
 * 全部无 IO —— 抓取与落库在 `server/prompts.ts`，读库在 `packages/db`。
 * 这样切分的理由：单测环境是 `environment: 'node'`（无 jsdom），只有纯函数能被钉住。
 *
 * 逻辑照抄上游 infinite-canvas 的 `services/api/prompt-source-runtime.ts` 与
 * `services/api/prompts.ts`（`normalizeItems` / `sourceSignature` / `filterPrompts`），
 * 差异只有一处：**丢弃** `imageMode` / `imageModel` / `imageSize` / `imageCount`
 * 四个字段（表单不用、库里也没有对应列，留着会变成「有类型无列」）。
 */

import type { PromptEntryInput, PromptEntryRow } from '@motif/db'
import {
  ALL_PROMPTS_OPTION,
  PROMPT_CACHE_TTL_MS,
  PROMPT_FAILURE_RETRY_MS,
  PROMPT_MAX_PAGE_SIZE,
  PROMPT_PAGE_SIZE,
  type PromptSourceDef,
} from './prompt-sources'

/** 一次提示词库查询的入参（接口层解析后传进来） */
export interface PromptQuery {
  keyword: string
  tags: string[]
  source: string
  page: number
  pageSize: number
}

// ---------- 解析上游 registry JSON ----------

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

/** 字符串或数字都当字符串取（上游如此：某些源的 id 是数字） */
function stringValue(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(stringValue).map((s) => s.trim()).filter(Boolean) : []
}

/** 把条目里的相对路径解析成绝对 URL；解析不了就原样返回 */
function absoluteUrl(baseUrl: string, path: string): string {
  if (!path) return ''
  try {
    return new URL(path, baseUrl).toString()
  } catch {
    return path
  }
}

/**
 * 解析一个源的 registry JSON。
 *
 * - 根不是数组 ⇒ 抛错（原因文案**不带源名**：源名由调用方在 `failures[].sourceName`
 *   里单独提供，界面按「源名：原因」拼，避免同一句话里把源名说两遍）
 * - 缺 `title` 或 `prompt` 的条目 ⇒ 跳过（不抛：一个坏条目不该废掉整个源）
 * - 源内 `id` 重复 ⇒ 只留第一条
 * - `id` 缺失 ⇒ 用 `${sourceId}-${序号 4 位补零}` 兜底（与上游一致，序号 = 数组下标 + 1）
 * - `coverUrl` 缺失 ⇒ 回退 `referenceImageUrls[0]`（列表要有图可看）
 */
export function parsePromptSourcePayload(
  raw: unknown,
  source: { id: string; url: string }
): PromptEntryInput[] {
  if (!Array.isArray(raw)) throw new Error('返回的不是提示词数组')
  const seen = new Set<string>()
  const out: PromptEntryInput[] = []
  raw.forEach((value, index) => {
    const record = asRecord(value)
    const title = stringValue(record.title).trim()
    const prompt = stringValue(record.prompt).trim()
    if (!title || !prompt) return
    const id = stringValue(record.id).trim() || `${source.id}-${String(index + 1).padStart(4, '0')}`
    if (seen.has(id)) return
    seen.add(id)
    const referenceImageUrls = stringArray(record.referenceImageUrls).map((url) => absoluteUrl(source.url, url))
    const coverUrl = absoluteUrl(source.url, stringValue(record.coverUrl)) || referenceImageUrls[0] || ''
    out.push({
      id,
      title,
      prompt,
      description: stringValue(record.description),
      coverUrl,
      referenceImageUrls,
      tags: stringArray(record.tags),
      author: stringValue(record.author),
      sourceUrl: absoluteUrl(source.url, stringValue(record.sourceUrl)),
    })
  })
  return out
}

// ---------- 源签名与陈旧判定 ----------

/** `${name}\n${url}\n${homepage}` 的 31 乘 hash，前缀长度（照抄上游：源信息变了签名即变） */
export function sourceSignature(def: { name: string; url: string; homepage: string }): string {
  const value = `${def.name}\n${def.url}\n${def.homepage}`
  let hash = 0
  for (let i = 0; i < value.length; i += 1) hash = (hash * 31 + value.charCodeAt(i)) | 0
  return `${value.length}:${hash}`
}

/**
 * 这个源要不要抓？
 *
 * - 从未抓过 / `fetched_at` 解析不出时刻 / 签名与代码清单不一致 ⇒ 陈旧
 * - 否则按「上次抓得成不成」选节奏：**失败源用短节奏**（`failureRetryMs`），
 *   成功源用 `ttlMs`。失败源用短节奏是本仓对上游的有意偏离 —— 上游是单浏览器
 *   单用户，失败后每次读都重试代价可接受；本仓是服务端，若失败源每次请求都触发
 *   一次外网抓取，N 个并发用户会把一个死源打成压测目标。
 */
export function isSourceStale(input: {
  fetchedAt: string | null
  signature: string
  lastError: string
  def: PromptSourceDef
  now: number
  ttlMs?: number
  failureRetryMs?: number
}): boolean {
  if (!input.fetchedAt) return true
  if (input.signature !== sourceSignature(input.def)) return true
  const fetched = Date.parse(input.fetchedAt)
  if (Number.isNaN(fetched)) return true
  const ttl = input.lastError ? (input.failureRetryMs ?? PROMPT_FAILURE_RETRY_MS) : (input.ttlMs ?? PROMPT_CACHE_TTL_MS)
  return input.now - fetched >= ttl
}

// ---------- 筛选 / 分面 / 分页 ----------

function isActiveOption(value: string): boolean {
  return Boolean(value) && value !== ALL_PROMPTS_OPTION
}

/**
 * 筛选。顺序与语义照抄上游 `filterPrompts`：
 * 来源（**精确**匹配源名，`all`/空不筛）→ 标签（多选 = **OR**，命中任一即留）
 * → 关键词（对 标题/正文/描述/源名/全部标签 做小写子串匹配）。
 */
export function filterPromptEntries<T extends PromptEntryRow>(
  entries: readonly T[],
  options: { keyword: string; tags: readonly string[]; source: string }
): T[] {
  const keyword = options.keyword.trim().toLowerCase()
  return entries.filter((entry) => {
    if (isActiveOption(options.source) && entry.sourceName !== options.source) return false
    if (options.tags.length > 0 && !options.tags.some((tag) => entry.tags.includes(tag))) return false
    if (!keyword) return true
    return [entry.title, entry.prompt, entry.description, entry.sourceName, ...entry.tags]
      .join(' ')
      .toLowerCase()
      .includes(keyword)
  })
}

/** 去重后的标签面，按首次出现顺序（稳定：下拉不会因为翻页而重排） */
export function collectPromptTags(entries: readonly { tags: string[] }[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of entries) {
    for (const tag of entry.tags) {
      if (!tag || seen.has(tag)) continue
      seen.add(tag)
      out.push(tag)
    }
  }
  return out
}

/** 页码与页大小都做钳制；越界页返回空数组（调用方据此显示空态） */
export function paginatePromptEntries<T>(entries: readonly T[], page: number, pageSize: number): T[] {
  const size = Math.max(1, Math.min(PROMPT_MAX_PAGE_SIZE, Math.floor(pageSize) || PROMPT_PAGE_SIZE))
  const index = Math.max(1, Math.floor(page) || 1)
  return entries.slice((index - 1) * size, index * size)
}

/** 解析查询参数：逗号分隔的标签、钳制的页码与页大小、缺省值 */
export function parsePromptQuery(searchParams: URLSearchParams): PromptQuery {
  const rawTags = (searchParams.get('tags') ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
  const tags = Array.from(new Set(rawTags))
  const page = Number.parseInt(searchParams.get('page') ?? '', 10)
  const pageSize = Number.parseInt(searchParams.get('pageSize') ?? '', 10)
  return {
    keyword: (searchParams.get('q') ?? '').trim(),
    tags,
    source: (searchParams.get('source') ?? '').trim() || ALL_PROMPTS_OPTION,
    page: Number.isFinite(page) && page > 0 ? page : 1,
    pageSize: Number.isFinite(pageSize) && pageSize > 0 ? Math.min(pageSize, PROMPT_MAX_PAGE_SIZE) : PROMPT_PAGE_SIZE,
  }
}

// ---------- 示例图（详情弹窗与「用作参考图」共用同一份算法）----------

/** 一条条目最多展示几张示例图：1 张封面 + 6 张缩略图（与上游的 6 列网格对齐） */
export const PROMPT_ENTRY_MAX_IMAGES = 7

/**
 * 一条提示词的可展示图片列表：**封面在前**，其余按原顺序，去重、丢空。
 *
 * ⚠️ 这个算法**只有这一处**：接口把算好的数组返回给前端，前端按 index 回传
 * 「第几张」给服务端取 URL。前端若自己重算一遍，两边的顺序/去重规则一漂移，
 * 用户点的图和服务端取的图就不是同一张了。
 */
export function promptEntryImages(entry: { coverUrl: string; referenceImageUrls: string[] }): string[] {
  const out: string[] = []
  for (const raw of [entry.coverUrl, ...entry.referenceImageUrls]) {
    // 纯空白也要丢：它会渲染成破图，抓取时也是一定失败的地址
    const url = raw.trim()
    if (url && !out.includes(url)) out.push(url)
    if (out.length >= PROMPT_ENTRY_MAX_IMAGES) break
  }
  return out
}

// ---------- 远程图 URL 安全闸 ----------

/** 内网域名（不做 DNS 解析，故只挡字面量） */
const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home', '.corp']

function isPrivateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return false
  const octets = [m[1], m[2], m[3], m[4]].map(Number)
  // 越界写法（如 999.1.1.1）解析器不会放行，这里再兜一层：不认识就当不安全
  if (octets.some((o) => o > 255)) return true
  const [a, b] = octets
  return (
    a === 0 || // 0.0.0.0/8「本网络」
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) || // 链路本地（云元数据服务就在这）
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224 // 组播与保留段
  )
}

/** 两个 16 位组拼成的 IPv4 是否内网 */
function isPrivateIpv4Pair(hi: number, lo: number): boolean {
  return isPrivateIpv4([(hi >>> 8) & 255, hi & 255, (lo >>> 8) & 255, lo & 255].join('.'))
}

/**
 * 把 IPv6 字面量展开成 8 组 16 位整数（`::` 补零、末尾内嵌点分 IPv4 折成两组）。
 *
 * **为什么要展开而不是拿正则去匹配几种写法**：`::ffff:127.0.0.1` 这类地址有太多种等价
 * 写法（点分/十六进制、转译/NAT64/6to4 前缀），逐个写正则必然漏；展开成定长数组后，
 * 「内嵌的 IPv4 是哪两组」就是一个确定的判断。
 */
function expandIpv6(host: string): number[] | null {
  let h = host.replace(/^\[|\]$/g, '').toLowerCase()
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (dotted) {
    const octets = [dotted[1], dotted[2], dotted[3], dotted[4]].map(Number)
    if (octets.some((o) => o > 255)) return null
    // 原地折成两组十六进制（保留 `::` 的位置信息，不能先把尾巴切掉再解析）
    const folded = [(octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]].map((n) => n.toString(16)).join(':')
    h = `${h.slice(0, dotted.index)}${folded}`
  }
  const parts = h.split('::')
  if (parts.length > 2) return null
  const parseGroups = (part: string): number[] | null => {
    if (!part) return []
    const out: number[] = []
    for (const g of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null
      out.push(Number.parseInt(g, 16))
    }
    return out
  }
  const left = parseGroups(parts[0])
  const right = parts.length === 2 ? parseGroups(parts[1]) : null
  if (!left || !right) return null
  if (parts.length === 2) {
    const fill = 8 - left.length - right.length
    if (fill < 1) return null // `::` 至少要压缩掉一组
    return [...left, ...new Array<number>(fill).fill(0), ...right]
  }
  return left.length === 8 ? left : null
}

function isPrivateIpv6(host: string): boolean {
  if (!host.includes(':')) return false
  const g = expandIpv6(host)
  if (!g) return true // 展开不了 ⇒ 保守当成不安全，畸形地址不该被当作公网
  if (g.every((n) => n === 0)) return true // :: 未指定
  if (g.slice(0, 7).every((n) => n === 0) && g[7] === 1) return true // ::1 回环
  if ((g[0] & 0xfe00) === 0xfc00) return true // fc00::/7 唯一本地
  if ((g[0] & 0xffc0) === 0xfe80) return true // fe80::/10 链路本地
  if ((g[0] & 0xff00) === 0xff00) return true // ff00::/8 组播
  // 内嵌 IPv4 的转译/隧道写法。⚠️ WHATWG URL 会把 `[::ffff:127.0.0.1]` 归一化成
  // `[::ffff:7f00:1]`，只认点分写法会漏；同理还有 IPv4 转译、NAT64、6to4 三种前缀。
  if (g.slice(0, 6).every((n) => n === 0)) return isPrivateIpv4Pair(g[6], g[7]) // ::a.b.c.d（IPv4 兼容）
  if (g.slice(0, 5).every((n) => n === 0) && g[5] === 0xffff) return isPrivateIpv4Pair(g[6], g[7]) // ::ffff:a.b.c.d
  if (g.slice(0, 4).every((n) => n === 0) && g[4] === 0xffff && g[5] === 0) return isPrivateIpv4Pair(g[6], g[7]) // ::ffff:0:a.b.c.d（IPv4 转译）
  if (g[0] === 0x0064 && g[1] === 0xff9b) return isPrivateIpv4Pair(g[6], g[7]) // 64:ff9b::/96 与 64:ff9b:1::/48（NAT64）
  if (g[0] === 0x2002) return isPrivateIpv4Pair(g[1], g[2]) // 2002::/16（6to4）
  return false
}

/**
 * 这张远程图能不能抓？
 *
 * 只允许 http/https，且拒绝指向内网的目标。**为什么需要这道闸**：URL 虽然取自
 * 我们自己库里缓存的条目，但那些内容来自**第三方开源仓库**，若其中混入
 * `http://169.254.169.254/…` 或 `http://127.0.0.1:3100/api/…`，服务端就会变成跳板。
 *
 * ⚠️ **已知边界**：不做 DNS 解析，故「公网域名解析到内网 IP」这条不挡；
 * 跳转由调用方逐跳复检（`redirect: 'manual'`），不是只查第一跳。
 */
export function isSafeRemoteImageUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  const host = url.hostname.toLowerCase()
  if (!host) return false
  if (host === 'localhost' || BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return false
  return !isPrivateIpv4(host) && !isPrivateIpv6(host)
}

// ---------- 站内静态资源与「能不能带进参考图」 ----------

/**
 * 站内静态资源的白名单：只允许 `/` 开头的 `.jpg|jpeg|png|webp` 路径。
 *
 * 用**保守字符白名单**（字母数字与 `._-/`）而不是黑名单：NUL（`%00`）、空格、`?`、`#`、
 * 反斜杠、Unicode 一律拒掉 —— 我们自己的模板图不需要这些字符，放行它们只会给
 * 「绕过 `..` 检查」留口子。`..` 与 `//`（协议相对）单独再挡一层。
 */
export function isSafePublicAssetPath(raw: string): boolean {
  if (!/^\/[A-Za-z0-9._/-]+\.(jpe?g|png|webp)$/i.test(raw)) return false
  if (raw.startsWith('//') || raw.includes('..')) return false
  return true
}

/**
 * 这张示例图能不能带进参考图？
 * - 远程图：过 `isSafeRemoteImageUrl`（http/https + 非内网）
 * - 站内静态图（系统自带模板的 `/templates/*.jpg`）：过 `isSafePublicAssetPath`
 * 其它（`data:`、`file:`、畸形串）一律不行。
 *
 * ⚠️ **按单张图判**，不要把它聚合到「整条条目」上：第三方源里完全可能出现
 * 「封面可带、某张缩略图不可带」的混合形态，聚合后前端就会给不可带的那张也渲染按钮。
 */
export function isAttachableImage(url: string): boolean {
  return isSafeRemoteImageUrl(url) || isSafePublicAssetPath(url)
}
