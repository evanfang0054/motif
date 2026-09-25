import { describe, expect, it } from 'vitest'
import type { PromptEntryRow } from '@motif/db'
import { BUILT_IN_PROMPT_ENTRIES, BUILT_IN_PROMPT_SOURCE } from '@/lib/prompt-builtins'
import {
  ALL_PROMPTS_OPTION,
  BUILT_IN_PROMPT_SOURCES,
  REMOTE_PROMPT_SOURCES,
  isFetchableSource,
  PROMPT_ATTACH_TIMEOUT_MS,
  PROMPT_CACHE_TTL_MS,
  PROMPT_FAILURE_RETRY_MS,
  PROMPT_FETCH_TIMEOUT_MS,
  PROMPT_REGISTRY_SOURCE_BASE,
} from '@/lib/prompt-sources'
import {
  PROMPT_ENTRY_MAX_IMAGES,
  collectPromptTags,
  filterPromptEntries,
  isSourceStale,
  paginatePromptEntries,
  parsePromptQuery,
  isSafeRemoteImageUrl,
  parsePromptSourcePayload,
  promptEntryImages,
  sourceSignature,
} from '@/lib/prompts'

const SRC = { id: 'src-a', name: '源 A', url: 'https://example.com/sources/a.json' }

function row(over: Partial<PromptEntryRow> = {}): PromptEntryRow {
  return {
    sourceId: 'src-a',
    sourceName: '源 A',
    sortIndex: 0,
    id: 'x',
    title: '标题',
    prompt: '提示词',
    description: '',
    coverUrl: '',
    referenceImageUrls: [],
    tags: [],
    author: '',
    sourceUrl: '',
    ...over,
  }
}

describe('内置源清单', () => {
  it('可抓取的远程源只有 5 个 GPT 系，逐字对齐上游 registry 清单', () => {
    // 逐字钉住：改错 id / 名称 / 出处会红（清单是代码里的真相，DB 只是副本）。
    // 只留 GPT 系是用户裁决 —— Motif 的模型是 gpt-image 系，另一套模型族
    // （Nano Banana / Banana Prompt Quicker）的提示词不通用。
    expect(REMOTE_PROMPT_SOURCES.map((s) => [s.id, s.name, s.homepage])).toEqual([
      ['davidwu-gpt-image2-prompts', 'DavidWu GPT Image 2', 'https://github.com/davidwuw0811-boop/awesome-gpt-image2-prompts'],
      ['freestylefly-gpt-image-2', 'Freestylefly GPT Image 2', 'https://github.com/freestylefly/awesome-gpt-image-2'],
      ['awesome-gpt-image', 'Awesome GPT Image', 'https://github.com/ZeroLu/awesome-gpt-image'],
      ['awesome-gpt4o-image-prompts', 'Awesome GPT-4o', 'https://github.com/ImgEdify/Awesome-GPT4o-Image-Prompts'],
      ['youmind-gpt-image-2', 'YouMind GPT Image 2', 'https://github.com/YouMind-OpenLab/awesome-gpt-image-2'],
    ])
    expect(REMOTE_PROMPT_SOURCES.every((s) => s.id.includes('gpt'))).toBe(true)
  })

  it('url 由 registry 根地址与 id 拼出', () => {
    expect(REMOTE_PROMPT_SOURCES.map((s) => s.url)).toEqual(
      REMOTE_PROMPT_SOURCES.map((s) => `${PROMPT_REGISTRY_SOURCE_BASE}/${s.id}.json`)
    )
    expect(REMOTE_PROMPT_SOURCES.every((s) => s.url.startsWith('https://raw.githubusercontent.com/'))).toBe(true)
  })

  it('全部内置源 = 5 个远程源 + 1 个不可抓取的「系统自带」', () => {
    expect(BUILT_IN_PROMPT_SOURCES).toHaveLength(6)
    expect(BUILT_IN_PROMPT_SOURCES[BUILT_IN_PROMPT_SOURCES.length - 1]).toEqual(BUILT_IN_PROMPT_SOURCE)
    expect(BUILT_IN_PROMPT_SOURCE).toEqual({ id: 'motif-builtin', name: '系统自带', url: '', homepage: '' })
  })

  it('isFetchableSource：只有空 url 的源（系统自带）不抓', () => {
    expect(REMOTE_PROMPT_SOURCES.every(isFetchableSource)).toBe(true)
    expect(isFetchableSource(BUILT_IN_PROMPT_SOURCE)).toBe(false)
    expect(isFetchableSource({ url: '   ' })).toBe(false)
  })

  it('「系统自带」条目就是原「从模板开始」那 8 个模板，图是站内静态资源', () => {
    expect(BUILT_IN_PROMPT_ENTRIES).toHaveLength(8)
    expect(BUILT_IN_PROMPT_ENTRIES.map((e) => e.id)).toEqual([
      'ecommerce-suite',
      'world-landmarks',
      'portrait-editorial',
      'wedding-portrait',
      'senior-portrait',
      'men-editorial',
      'women-elegant',
      'kids-series',
    ])
    // 「对应的提示词显示对应的图」：coverUrl 指到该模板自己的预览图
    for (const e of BUILT_IN_PROMPT_ENTRIES) {
      expect(e.coverUrl, e.id).toBe(`/templates/${e.id}.jpg`)
      expect(e.prompt.length, e.id).toBeGreaterThan(20)
      expect(e.title.length, e.id).toBeGreaterThan(0)
    }
  })
})

describe('parsePromptSourcePayload', () => {
  it('根不是数组 ⇒ 抛错（原因文案不带源名，源名由调用方拼）', () => {
    expect(() => parsePromptSourcePayload({ items: [] }, SRC)).toThrowError('返回的不是提示词数组')
    expect(() => parsePromptSourcePayload('nope', SRC)).toThrowError(/不是提示词数组/)
    expect(() => parsePromptSourcePayload(null, SRC)).toThrowError(/不是提示词数组/)
  })

  it('缺 title 或 prompt 的条目跳过，其余照收', () => {
    const out = parsePromptSourcePayload(
      [{ title: '只有标题' }, { prompt: '只有提示词' }, { title: '好条目', prompt: '正文' }, {}, null, 42],
      SRC
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ title: '好条目', prompt: '正文' })
  })

  it('id 缺失时用源 id + 4 位补零序号兜底（序号 = 数组下标 + 1）', () => {
    const out = parsePromptSourcePayload(
      [{ title: 'a', prompt: 'a' }, { title: 'b', prompt: 'b' }, { title: 'c', prompt: 'c', id: '自带的' }],
      SRC
    )
    expect(out.map((e) => e.id)).toEqual(['src-a-0001', 'src-a-0002', '自带的'])
  })

  it('id 是数字也当字符串取；同 id 只留第一条', () => {
    const out = parsePromptSourcePayload(
      [
        { id: 7, title: '第一', prompt: 'p1' },
        { id: '7', title: '第二', prompt: 'p2' },
        { id: 8, title: '第三', prompt: 'p3' },
      ],
      SRC
    )
    expect(out.map((e) => [e.id, e.title])).toEqual([
      ['7', '第一'],
      ['8', '第三'],
    ])
  })

  it('相对 URL 绝对化；coverUrl 回退到第一张参考图', () => {
    const out = parsePromptSourcePayload(
      [{ title: 't', prompt: 'p', coverUrl: './cover.png', referenceImageUrls: ['../img/1.png'], sourceUrl: 'detail/1' }],
      SRC
    )
    expect(out[0].coverUrl).toBe('https://example.com/sources/cover.png')
    expect(out[0].referenceImageUrls).toEqual(['https://example.com/img/1.png'])
    expect(out[0].sourceUrl).toBe('https://example.com/sources/detail/1')

    const noCover = parsePromptSourcePayload([{ title: 't', prompt: 'p', referenceImageUrls: ['https://cdn.example.com/a.png'] }], SRC)
    expect(noCover[0].coverUrl).toBe('https://cdn.example.com/a.png')

    const nothing = parsePromptSourcePayload([{ title: 't', prompt: 'p' }], SRC)
    expect(nothing[0].coverUrl).toBe('')
    expect(nothing[0].referenceImageUrls).toEqual([])
  })

  it('坏 URL 原样保留（不抛、不变成空串）', () => {
    const out = parsePromptSourcePayload([{ title: 't', prompt: 'p', sourceUrl: 'http://[bad' }], SRC)
    expect(out[0].sourceUrl).toBe('http://[bad')
  })

  it('tags 过滤空串并 trim；非数组当空', () => {
    const out = parsePromptSourcePayload(
      [
        { title: 't', prompt: 'p', tags: [' 写实 ', '', '海报', 7] },
        { title: 't2', prompt: 'p2', tags: 'not-an-array' },
      ],
      SRC
    )
    expect(out[0].tags).toEqual(['写实', '海报', '7'])
    expect(out[1].tags).toEqual([])
  })

  it('不产出表单不用的图片参数（有类型无列会把实现带进死路）', () => {
    const out = parsePromptSourcePayload(
      [{ title: 't', prompt: 'p', imageMode: 'edit', imageModel: 'gpt-image-2', imageSize: '1024x1024', imageCount: 4 }],
      SRC
    )
    expect(Object.keys(out[0]).sort()).toEqual(
      ['author', 'coverUrl', 'description', 'id', 'prompt', 'referenceImageUrls', 'sourceUrl', 'tags', 'title'].sort()
    )
  })

  it('空数组返回空（是否算失败由调用方决定）', () => {
    expect(parsePromptSourcePayload([], SRC)).toEqual([])
  })
})

describe('sourceSignature', () => {
  const def = { name: '源 A', url: 'https://a/1.json', homepage: 'https://a/' }

  it('同源稳定；name / url / homepage 任一变化即变', () => {
    const base = sourceSignature(def)
    expect(sourceSignature({ ...def })).toBe(base)
    expect(sourceSignature({ ...def, name: '源 B' })).not.toBe(base)
    expect(sourceSignature({ ...def, url: 'https://a/2.json' })).not.toBe(base)
    expect(sourceSignature({ ...def, homepage: 'https://b/' })).not.toBe(base)
  })

  it('格式是 `长度:hash`', () => {
    expect(sourceSignature(def)).toMatch(/^\d+:-?\d+$/)
  })
})

describe('isSourceStale', () => {
  const def = { id: 'src-a', name: '源 A', url: 'https://a/1.json', homepage: 'https://a/' }
  const now = Date.parse('2026-09-21T12:00:00.000Z')
  const sig = sourceSignature(def)
  const ok = { fetchedAt: '2026-09-21T11:30:00.000Z', signature: sig, lastError: '', def, now }

  it('从未抓过 ⇒ 陈旧', () => {
    expect(isSourceStale({ ...ok, fetchedAt: null })).toBe(true)
  })

  it('时刻解析不出 ⇒ 陈旧', () => {
    expect(isSourceStale({ ...ok, fetchedAt: '不是时间' })).toBe(true)
  })

  it('签名与代码清单不一致 ⇒ 陈旧（源地址改了要立刻重抓）', () => {
    expect(isSourceStale({ ...ok, signature: 'old-sig' })).toBe(true)
  })

  it('成功源按 1 小时判：30 分钟前抓过不算陈旧，2 小时前抓过算', () => {
    expect(isSourceStale(ok)).toBe(false)
    expect(isSourceStale({ ...ok, fetchedAt: '2026-09-21T10:00:00.000Z' })).toBe(true)
    expect(isSourceStale({ ...ok, fetchedAt: '2026-09-21T10:00:00.000Z', ttlMs: PROMPT_CACHE_TTL_MS })).toBe(true)
  })

  it('失败源按 5 分钟判：刚失败过不重试，超过 5 分钟才重试', () => {
    const failed = { ...ok, lastError: '抓取超时' }
    expect(isSourceStale({ ...failed, fetchedAt: '2026-09-21T11:58:00.000Z' })).toBe(false)
    expect(isSourceStale({ ...failed, fetchedAt: '2026-09-21T11:54:00.000Z' })).toBe(true)
    // 显式传参时以传入值为准
    expect(isSourceStale({ ...failed, fetchedAt: '2026-09-21T11:54:00.000Z', failureRetryMs: 60 * 60 * 1000 })).toBe(false)
    expect(PROMPT_FAILURE_RETRY_MS).toBe(5 * 60 * 1000)
  })

  it('失败源的短节奏优先于成功源的长 TTL（同一份 fetchedAt 结果不同）', () => {
    const at = '2026-09-21T11:50:00.000Z'
    expect(isSourceStale({ ...ok, fetchedAt: at })).toBe(false)
    expect(isSourceStale({ ...ok, fetchedAt: at, lastError: 'x' })).toBe(true)
  })
})

describe('抓取超时常量', () => {
  // 回归绊线：源抓取曾长期是 8s，而体积最大的两个上游源（约 1.01MiB / 1.19MiB）
  // 在慢链路上 8s 内下不完，表现为「部署到服务器后个别源一直抓取失败」。
  // ⚠️ 它只防「被改回小值」，**不构成**「服务器上真的能抓下来」的行为验证 ——
  // 那需要部署到目标机实测，不在单测射程内。
  it('源抓取不小于 30 秒（回归绊线，非行为验证）', () => {
    expect(PROMPT_FETCH_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000)
  })

  it('示例图抓取仍是 8 秒 —— 两条链路不共用一个常量', () => {
    expect(PROMPT_ATTACH_TIMEOUT_MS).toBe(8_000)
    expect(PROMPT_ATTACH_TIMEOUT_MS).not.toBe(PROMPT_FETCH_TIMEOUT_MS)
  })
})

describe('filterPromptEntries', () => {
  const entries = [
    row({ id: '1', title: '猫咪写真', prompt: 'a cat portrait', description: '室内', tags: ['写实', '宠物'], sourceName: '源 A' }),
    row({ id: '2', title: '海报排版', prompt: 'POSTER layout', description: '', tags: ['海报'], sourceName: '源 B' }),
    row({ id: '3', title: '风景', prompt: 'landscape', description: '写实风格', tags: [], sourceName: '源 A' }),
  ]

  it('关键词对 标题/正文/描述/源名/标签 做小写子串匹配', () => {
    expect(filterPromptEntries(entries, { keyword: 'CAT', tags: [], source: ALL_PROMPTS_OPTION }).map((e) => e.id)).toEqual(['1'])
    expect(filterPromptEntries(entries, { keyword: '海报', tags: [], source: ALL_PROMPTS_OPTION }).map((e) => e.id)).toEqual(['2'])
    expect(filterPromptEntries(entries, { keyword: '写实', tags: [], source: ALL_PROMPTS_OPTION }).map((e) => e.id)).toEqual(['1', '3'])
    expect(filterPromptEntries(entries, { keyword: '源 B', tags: [], source: ALL_PROMPTS_OPTION }).map((e) => e.id)).toEqual(['2'])
    expect(filterPromptEntries(entries, { keyword: '   ', tags: [], source: ALL_PROMPTS_OPTION })).toHaveLength(3)
  })

  it('标签多选 = OR（命中任一即留）', () => {
    expect(filterPromptEntries(entries, { keyword: '', tags: ['海报'], source: ALL_PROMPTS_OPTION }).map((e) => e.id)).toEqual(['2'])
    expect(filterPromptEntries(entries, { keyword: '', tags: ['宠物', '海报'], source: ALL_PROMPTS_OPTION }).map((e) => e.id)).toEqual(['1', '2'])
  })

  it('来源是源名精确匹配；all / 空串不筛', () => {
    expect(filterPromptEntries(entries, { keyword: '', tags: [], source: '源 A' }).map((e) => e.id)).toEqual(['1', '3'])
    expect(filterPromptEntries(entries, { keyword: '', tags: [], source: '源' })).toHaveLength(0)
    expect(filterPromptEntries(entries, { keyword: '', tags: [], source: ALL_PROMPTS_OPTION })).toHaveLength(3)
    expect(filterPromptEntries(entries, { keyword: '', tags: [], source: '' })).toHaveLength(3)
  })

  it('三个条件叠加', () => {
    expect(
      filterPromptEntries(entries, { keyword: 'cat', tags: ['写实'], source: '源 A' }).map((e) => e.id)
    ).toEqual(['1'])
    expect(filterPromptEntries(entries, { keyword: 'cat', tags: ['海报'], source: '源 A' })).toHaveLength(0)
  })
})

describe('collectPromptTags', () => {
  it('去重且按首次出现顺序（翻页不会重排下拉）', () => {
    expect(
      collectPromptTags([{ tags: ['b', 'a'] }, { tags: ['a', 'c'] }, { tags: ['', 'b'] }, { tags: [] }])
    ).toEqual(['b', 'a', 'c'])
  })
})

describe('paginatePromptEntries', () => {
  const items = Array.from({ length: 25 }, (_, i) => i)

  it('按页切片', () => {
    expect(paginatePromptEntries(items, 1, 10)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(paginatePromptEntries(items, 3, 10)).toEqual([20, 21, 22, 23, 24])
  })

  it('页码与页大小都钳制；越界页返回空数组', () => {
    expect(paginatePromptEntries(items, 0, 10)).toHaveLength(10)
    expect(paginatePromptEntries(items, -3, 10)).toHaveLength(10)
    expect(paginatePromptEntries(items, 1, 9999)).toHaveLength(25)
    expect(paginatePromptEntries(items, 1, 0)).toHaveLength(20)
    expect(paginatePromptEntries(items, 99, 10)).toEqual([])
  })
})

describe('parsePromptQuery', () => {
  it('缺省值：关键词空、标签空、来源 all、第 1 页、每页 20', () => {
    expect(parsePromptQuery(new URLSearchParams())).toEqual({
      keyword: '',
      tags: [],
      source: ALL_PROMPTS_OPTION,
      page: 1,
      pageSize: 20,
    })
  })

  it('标签逗号分隔、trim、去重；关键词 trim', () => {
    const q = parsePromptQuery(new URLSearchParams({ q: '  猫  ', tags: ' 写实 , 海报 ,,写实 ' }))
    expect(q.keyword).toBe('猫')
    expect(q.tags).toEqual(['写实', '海报'])
  })

  it('页码与页大小非法或超限时回退', () => {
    expect(parsePromptQuery(new URLSearchParams({ page: '0' })).page).toBe(1)
    expect(parsePromptQuery(new URLSearchParams({ page: '-2' })).page).toBe(1)
    expect(parsePromptQuery(new URLSearchParams({ page: 'abc' })).page).toBe(1)
    expect(parsePromptQuery(new URLSearchParams({ page: '3' })).page).toBe(3)
    expect(parsePromptQuery(new URLSearchParams({ pageSize: '500' })).pageSize).toBe(100)
    expect(parsePromptQuery(new URLSearchParams({ pageSize: '0' })).pageSize).toBe(20)
  })

  it('来源传空串等价于 all', () => {
    expect(parsePromptQuery(new URLSearchParams({ source: '   ' })).source).toBe(ALL_PROMPTS_OPTION)
    expect(parsePromptQuery(new URLSearchParams({ source: '源 A' })).source).toBe('源 A')
  })
})

describe('promptEntryImages（详情弹窗与「用作参考图」共用的唯一算法）', () => {
  it('封面在最前，其余按原顺序；封面重复出现在参考图里会被去掉', () => {
    expect(
      promptEntryImages({ coverUrl: 'https://a/c.png', referenceImageUrls: ['https://a/c.png', 'https://a/2.png', 'https://a/1.png'] })
    ).toEqual(['https://a/c.png', 'https://a/2.png', 'https://a/1.png'])
  })

  it('没有封面时只列参考图；空串一律丢掉', () => {
    expect(promptEntryImages({ coverUrl: '', referenceImageUrls: ['', 'https://a/1.png', '  '] })).toEqual(['https://a/1.png'])
    expect(promptEntryImages({ coverUrl: '', referenceImageUrls: [] })).toEqual([])
  })

  it('上限 7 张（1 封面 + 6 缩略图，与上游 6 列网格对齐）', () => {
    const many = Array.from({ length: 20 }, (_, i) => `https://a/${i}.png`)
    const out = promptEntryImages({ coverUrl: 'https://a/cover.png', referenceImageUrls: many })
    expect(out).toHaveLength(PROMPT_ENTRY_MAX_IMAGES)
    expect(out[0]).toBe('https://a/cover.png')
  })

  it('重复 URL 只留第一次出现的位置（保序）', () => {
    expect(promptEntryImages({ coverUrl: '', referenceImageUrls: ['https://a/1.png', 'https://a/1.png', 'https://a/2.png'] })).toEqual([
      'https://a/1.png',
      'https://a/2.png',
    ])
  })
})

describe('isSafeRemoteImageUrl（远程示例图的安全闸）', () => {
  it('放行正常的公网 http/https', () => {
    for (const url of [
      'https://raw.githubusercontent.com/a/b/main/x.png',
      'https://cdn.jsdelivr.net/gh/a/b@main/x.png',
      'http://example.com/x.jpg',
      'https://8.8.8.8/x.png',
      'https://[2606:4700::1111]/x.png',
    ]) {
      expect(isSafeRemoteImageUrl(url), url).toBe(true)
    }
  })

  it('只允许 http/https：其它协议一律拒绝', () => {
    for (const url of ['ftp://example.com/x.png', 'file:///etc/passwd', 'data:image/png;base64,AAAA', 'javascript:alert(1)', 'ws://example.com/x']) {
      expect(isSafeRemoteImageUrl(url), url).toBe(false)
    }
  })

  it('拒绝回环 / 内网 / 链路本地 IPv4（含十进制、十六进制、八进制写法）', () => {
    for (const url of [
      'http://127.0.0.1:3100/api/auth/me',
      'http://localhost/x.png',
      'http://10.1.2.3/x.png',
      'http://172.16.0.1/x.png',
      'http://172.31.255.254/x.png',
      'http://192.168.1.1/x.png',
      'http://169.254.169.254/latest/meta-data/',
      'http://0.0.0.0/x.png',
      'http://224.0.0.1/x.png',
      'http://2130706433/x.png', // 十进制写法：URL 解析器会归一化成 127.0.0.1
      'http://0x7f.1/x.png', // 十六进制写法
      'http://0177.0.0.1/x.png', // 八进制写法
    ]) {
      expect(isSafeRemoteImageUrl(url), url).toBe(false)
    }
  })

  it('拒绝回环 / 唯一本地 / 链路本地 IPv6，以及 IPv4 映射地址的两种写法', () => {
    for (const url of [
      'http://[::1]/x.png',
      'http://[::]/x.png',
      'http://[fc00::1]/x.png',
      'http://[fd12:3456::1]/x.png',
      'http://[fe80::1]/x.png',
      'http://[ff02::1]/x.png',
      'http://[::ffff:127.0.0.1]/x.png', // URL 解析器归一化成 hex 形式
      'http://[::ffff:7f00:1]/x.png',
      // 转译/隧道前缀内嵌的内网 IPv4：只挡「点分 + 十六进制」两种写法会漏
      'http://[::ffff:0:127.0.0.1]/x.png', // IPv4 转译（::ffff:0:0/96）
      'http://[::ffff:0:7f00:1]/x.png',
      'http://[64:ff9b::127.0.0.1]/x.png', // NAT64 well-known prefix
      'http://[64:ff9b::7f00:1]/x.png',
      'http://[64:ff9b:1::169.254.169.254]/x.png', // NAT64 本地前缀
      'http://[2002:7f00:1::]/x.png', // 6to4 内嵌 127.0.0.1
      'http://[2002:a9fe:a9fe::]/x.png', // 6to4 内嵌 169.254.169.254
    ]) {
      expect(isSafeRemoteImageUrl(url), url).toBe(false)
    }
  })

  it('放行内嵌公网 IPv4 的转译/隧道地址', () => {
    for (const url of [
      'http://[::ffff:8.8.8.8]/x.png',
      'http://[64:ff9b::808:808]/x.png', // 8.8.8.8
      'http://[2002:808:808::]/x.png', // 6to4 内嵌 8.8.8.8
    ]) {
      expect(isSafeRemoteImageUrl(url), url).toBe(true)
    }
  })

  it('拒绝内网域名后缀与畸形输入', () => {
    for (const url of ['http://a.local/x.png', 'http://svc.internal/x.png', 'http://x.localhost/x.png', 'http://db.corp/x.png', 'not a url', '', 'http://']) {
      expect(isSafeRemoteImageUrl(url), url).toBe(false)
    }
  })

  it('公网 IP 与正常域名不被误伤（172.32 已出私网段）', () => {
    expect(isSafeRemoteImageUrl('http://172.32.0.1/x.png')).toBe(true)
    expect(isSafeRemoteImageUrl('http://11.0.0.1/x.png')).toBe(true)
  })
})
