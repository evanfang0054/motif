/**
 * 提示词增强（enhance）的 LLM 客户端：与 `mailer.ts` 对称，**独立配置、必填才启用**。
 *
 * 为什么不复用生图网关：生图走 OpenAI 兼容的 **images** 端点，增强要的是
 * **chat/completions**；两者的域名、密钥、计费都可能不同。复用会让「只想换个增强模型」
 * 被迫改生图配置，也会让生图网关一故障就连带增强失败。
 *
 * 配置不全时**构造即抛错**（与 mailer 的「构造不抛、发信才抛」刻意不同）：增强是可选能力，
 * 没配好就该被 `configHealth` 判为未就绪、调用方直接跳过，不需要一个占位实现拖到运行时。
 */
export interface LlmClient {
  enhance(prompt: string): Promise<string>
}

const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_MODEL = 'gpt-4o-mini'

const SYSTEM_PROMPT =
  '你是商业图片生成提示词工程师。把用户的中文描述改写为更具体、更适合文生图的提示词：' +
  '补全主体/材质/光线/构图/风格，保留原意与语言，只输出改写后的提示词本身，不要解释、不要加引号。'

class OpenAiCompatLlm implements LlmClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
    private readonly timeoutMs: number
  ) {}

  async enhance(prompt: string): Promise<string> {
    const res = await fetch(`${this.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`提示词增强失败（${res.status}）：${text.slice(0, 200)}`)
    }
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const out = body.choices?.[0]?.message?.content?.trim()
    if (!out) throw new Error('提示词增强接口未返回内容')
    return out
  }
}

/** 从取值表构造增强客户端；端点或密钥缺失时直接抛错（让 configHealth 复用同一份判据） */
export function createLlmFromConfig(values: Record<string, string | undefined>): LlmClient {
  const baseUrl = values.LLM_API_BASE_URL
  const apiKey = values.LLM_API_KEY
  const missing = [!baseUrl && 'LLM_API_BASE_URL', !apiKey && 'LLM_API_KEY'].filter(Boolean)
  if (missing.length) throw new Error(`[motif] 提示词增强缺少配置：${missing.join(', ')}`)
  const rawTimeout = Number(values.LLM_TIMEOUT_MS)
  return new OpenAiCompatLlm(
    baseUrl!,
    apiKey!,
    values.LLM_MODEL || DEFAULT_MODEL,
    Number.isInteger(rawTimeout) && rawTimeout > 0 ? rawTimeout : DEFAULT_TIMEOUT_MS
  )
}
