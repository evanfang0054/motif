import { OpenAICompatProvider } from './openai-compat'
import type { ImageProvider } from './provider'

export { OpenAICompatProvider, normalizeSize } from './openai-compat'
export type { ImageProvider, GenerateRequest, GeneratedImage } from './provider'

/**
 * 从取值表创建生图 Provider（OpenAI 兼容网关，gpt-image 系）。
 * 必需：IMAGE_API_BASE_URL、IMAGE_API_KEY；可选：IMAGE_MODEL（默认 gpt-image-2）。
 *
 * 形参刻意放宽为 `Record<string, string | undefined>` 而不是 `NodeJS.ProcessEnv`：
 * 配置来源已从「环境变量」变成「数据库优先、回退 env」，而 `Record<string, string | undefined>`
 * **不能**赋给 `NodeJS.ProcessEnv`（后者在 Next 的类型环境里有必填的 NODE_ENV）。
 */
export function createImageProviderFromEnv(env: Record<string, string | undefined> = process.env): ImageProvider {
  const baseUrl = env.IMAGE_API_BASE_URL
  const apiKey = env.IMAGE_API_KEY
  if (!baseUrl || !apiKey) {
    throw new Error(
      '[motif] 缺少生图网关配置：请在管理后台「系统设置 → 生图网关」填写 IMAGE_API_BASE_URL 与 IMAGE_API_KEY'
    )
  }
  return new OpenAICompatProvider(baseUrl, apiKey, env.IMAGE_MODEL || 'gpt-image-2')
}
