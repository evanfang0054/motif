import { resolveSize } from '@motif/core'
import sharp from 'sharp'
import type { GenerateRequest, GeneratedImage, ImageProvider } from './provider'

export type { ImageProvider, GenerateRequest, GeneratedImage }

/** 网关支持的尺寸档位（gpt-image 系） */
const SUPPORTED_SIZES = ['1024x1024', '1024x1536', '1536x1024'] as const

/** 把请求尺寸归一到网关支持的档位：按宽高比就近吸附 */
export function normalizeSize(size: string): string {
  if ((SUPPORTED_SIZES as readonly string[]).includes(size)) return size
  const { width, height } = resolveSize(size)
  const ratio = width / height
  if (ratio > 1.2) return '1536x1024'
  if (ratio < 0.83) return '1024x1536'
  return '1024x1024'
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

/**
 * OpenAI 兼容生图 Provider（gpt-image 系网关）。
 * 文生图：POST {baseUrl}/images/generations（最小 JSON 参数，恒返 b64_json）
 * 图生图：POST {baseUrl}/images/edits（multipart 携带参考图）
 */
export class OpenAICompatProvider implements ImageProvider {
  readonly name: string

  constructor(
    private baseUrl: string,
    private apiKey: string,
    private model = 'gpt-image-2',
    private fetchFn: FetchFn = fetch
  ) {
    this.name = model
  }

  async generate(req: GenerateRequest): Promise<GeneratedImage> {
    const size = normalizeSize(req.size)
    const refs = req.referenceImages ?? []
    const url = `${this.baseUrl.replace(/\/$/, '')}${refs.length > 0 ? '/images/edits' : '/images/generations'}`

    let init: RequestInit
    if (refs.length > 0) {
      // 图生图：multipart 携带参考图（网关已实测支持）
      const form = new FormData()
      form.append('model', this.model)
      form.append('prompt', req.prompt)
      form.append('size', size)
      refs.forEach((ref, i) => {
        const name = refs.length === 1 ? 'image' : 'image[]'
        form.append(name, new Blob([new Uint8Array(ref.buffer)], { type: ref.mimeType }), `reference-${i + 1}.png`)
      })
      init = { method: 'POST', body: form, signal: AbortSignal.timeout(180_000) }
    } else {
      // 文生图：最小 JSON 参数（response_format 会导致上游失败，不传）
      init = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, prompt: req.prompt, size }),
        signal: AbortSignal.timeout(180_000),
      }
    }
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${this.apiKey}`)
    init.headers = headers

    const res = await this.fetchFn(url, init)

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`生图接口失败（${res.status}）：${text.slice(0, 200)}`)
    }

    const payload = (await res.json()) as { data?: Array<{ b64_json?: string; url?: string }> }
    const item = payload.data?.[0]
    if (!item) throw new Error('生图接口未返回图片数据')

    let buffer: Buffer
    let mimeType = 'image/png'
    if (item.b64_json) {
      buffer = Buffer.from(item.b64_json, 'base64')
    } else if (item.url) {
      const imgRes = await this.fetchFn(item.url, { signal: AbortSignal.timeout(60_000) })
      if (!imgRes.ok) throw new Error(`下载生成图片失败（${imgRes.status}）`)
      buffer = Buffer.from(await imgRes.arrayBuffer())
      // 白名单校验，防恶意网关回吐非图片内容造成同源存储型 XSS
      const headerMime = (imgRes.headers.get('content-type') || 'image/png').split(';')[0].trim()
      if (!/^image\/(png|jpeg|webp)$/.test(headerMime)) {
        throw new Error(`生成图片内容类型异常：${headerMime}`)
      }
      mimeType = headerMime
    } else {
      throw new Error('生图接口响应缺少图片数据')
    }

    // 以实际图片尺寸为准（模型可能微调宽高）
    const meta = await sharp(buffer).metadata()
    return {
      buffer,
      mimeType,
      width: meta.width ?? Number(size.split('x')[0]),
      height: meta.height ?? Number(size.split('x')[1]),
    }
  }
}
