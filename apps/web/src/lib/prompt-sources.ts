/**
 * 提示词源清单与抓取常量 —— **源清单的唯一真相**。
 *
 * 上游 infinite-canvas 用 Zustand + persist 在浏览器里管源（可增删改、可定时刷新）；
 * 本仓刻意不做源自定义：清单写死在代码里，DB 只存抓取状态（见 `packages/db` 的
 * `prompt_sources`）。这样改源地址只需改本文件、重启即生效，而抓取状态不丢。
 */

import { BUILT_IN_PROMPT_SOURCE } from './prompt-builtins'

export interface PromptSourceDef {
  id: string
  name: string
  url: string
  homepage: string
}

/** 上游 registry 的 JSON 导出根地址（每个源一个 `<id>.json`） */
export const PROMPT_REGISTRY_SOURCE_BASE =
  'https://raw.githubusercontent.com/yukkcat/image-prompts/main/dist/sources'

const SOURCE_SEEDS: ReadonlyArray<Omit<PromptSourceDef, 'url'>> = [
  // 只留 **GPT 系** 的源（用户裁决）：Motif 的模型是 gpt-image 系，另一套模型族的提示词
  // （Nano Banana / Banana Prompt Quicker）与它不通用，留着只会让人挑错。
  { id: 'davidwu-gpt-image2-prompts', name: 'DavidWu GPT Image 2', homepage: 'https://github.com/davidwuw0811-boop/awesome-gpt-image2-prompts' },
  { id: 'freestylefly-gpt-image-2', name: 'Freestylefly GPT Image 2', homepage: 'https://github.com/freestylefly/awesome-gpt-image-2' },
  { id: 'awesome-gpt-image', name: 'Awesome GPT Image', homepage: 'https://github.com/ZeroLu/awesome-gpt-image' },
  { id: 'awesome-gpt4o-image-prompts', name: 'Awesome GPT-4o', homepage: 'https://github.com/ImgEdify/Awesome-GPT4o-Image-Prompts' },
  { id: 'youmind-gpt-image-2', name: 'YouMind GPT Image 2', homepage: 'https://github.com/YouMind-OpenLab/awesome-gpt-image-2' },
]

/** 内置的**可抓取**远程源（5 个 GPT 系；单测把这张表逐字钉住，改错会红） */
export const REMOTE_PROMPT_SOURCES: readonly PromptSourceDef[] = SOURCE_SEEDS.map((s) => ({
  ...s,
  url: `${PROMPT_REGISTRY_SOURCE_BASE}/${s.id}.json`,
}))

/**
 * 全部内置源 = 可抓取的远程源 + 「系统自带」（本地播种，不可抓取）。
 *
 * ⚠️ **清单是真相**：`seedPromptSources` 会按它同步并**删掉不在清单里的源**
 * （连同其条目）—— 所以从清单里去掉一个源，它会真的从库里消失，而不是继续挂在筛选栏上。
 */
export const BUILT_IN_PROMPT_SOURCES: readonly PromptSourceDef[] = [...REMOTE_PROMPT_SOURCES, BUILT_IN_PROMPT_SOURCE]

/** 这个源要不要抓？空 `url` 的源（系统自带）由代码播种，永远不 fetch */
export function isFetchableSource(def: { url: string }): boolean {
  return def.url.trim() !== ''
}

/** 抓取成功后的缓存有效期（与上游一致：1 小时） */
export const PROMPT_CACHE_TTL_MS = 60 * 60 * 1000

/**
 * 抓取失败后的重试节奏（**本仓对上游的有意偏离**）。
 *
 * 上游是单浏览器单用户，失败不更新 fetchedAt ⇒ 每次读都重试，代价可接受。
 * 本仓是服务端：若失败源每次 `GET /api/prompts` 都触发一次外网抓取，N 个并发用户
 * 会把一个死源打成压测目标。故失败源改用这个短节奏 —— 既不反复打，也能在源恢复后
 * 几分钟内自愈。管理员在系统设置点「立即刷新」**绕过**它，那是失败源唯一的人工恢复路径。
 */
export const PROMPT_FAILURE_RETRY_MS = 5 * 60 * 1000

/** 单个源的抓取上限：超时即中断，不让一个慢源拖住整批 */
export const PROMPT_FETCH_TIMEOUT_MS = 8000

export const PROMPT_PAGE_SIZE = 20
export const PROMPT_MAX_PAGE_SIZE = 100

/** 「不筛来源」的哨兵值（与上游同名同义） */
export const ALL_PROMPTS_OPTION = 'all'
