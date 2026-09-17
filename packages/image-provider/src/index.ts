import { OpenAICompatProvider } from './openai-compat'
import type { ImageProvider } from './provider'

export { OpenAICompatProvider, normalizeSize } from './openai-compat'
export type { ImageProvider, GenerateRequest, GeneratedImage } from './provider'

/**
 * 从环境变量创建生图 Provider（OpenAI 兼容网关，gpt-image 系）。
 * 必需：IMAGE_API_BASE_URL、IMAGE_API_KEY；可选：IMAGE_MODEL（默认 gpt-image-2）。
 */
export function createImageProviderFromEnv(env: NodeJS.ProcessEnv = process.env): ImageProvider {
  const baseUrl = env.IMAGE_API_BASE_URL
  const apiKey = env.IMAGE_API_KEY
  if (!baseUrl || !apiKey) {
    throw new Error('[motif] 缺少生图网关配置：请在 apps/web/.env 设置 IMAGE_API_BASE_URL 与 IMAGE_API_KEY（参考 .env.example）')
  }
  return new OpenAICompatProvider(baseUrl, apiKey, env.IMAGE_MODEL || 'gpt-image-2')
}
