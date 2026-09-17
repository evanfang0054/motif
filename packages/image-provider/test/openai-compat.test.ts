import { describe, expect, it } from 'vitest'
import { OpenAICompatProvider, createImageProviderFromEnv, normalizeSize } from '../src/index'

describe('normalizeSize', () => {
  it('预设尺寸直接透传', () => {
    expect(normalizeSize('1024x1024')).toBe('1024x1024')
    expect(normalizeSize('1024x1536')).toBe('1024x1536')
    expect(normalizeSize('1536x1024')).toBe('1536x1024')
  })
  it('auto 视为方图', () => {
    expect(normalizeSize('auto')).toBe('1024x1024')
  })
  it('自定义尺寸按宽高比吸附到最近档位', () => {
    expect(normalizeSize('800x1600')).toBe('1024x1536') // 竖
    expect(normalizeSize('1600x800')).toBe('1536x1024') // 横
    expect(normalizeSize('900x900')).toBe('1024x1024') // 方
    expect(normalizeSize('1300x1000')).toBe('1536x1024') // 轻横
  })
})

function fakeFetch(payload: unknown, status = 200) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })
  }) as unknown as (url: string, init?: RequestInit) => Promise<Response>
  return { fn, calls }
}

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

describe('OpenAICompatProvider', () => {
  it('文生图：请求体组装正确，b64_json 解码为 PNG', async () => {
    const { fn, calls } = fakeFetch({ data: [{ b64_json: PNG_1PX.toString('base64') }] })
    const provider = new OpenAICompatProvider('http://gw.example/v1', 'sk-test', 'gpt-image-2', fn)
    const img = await provider.generate({ prompt: '白瓷马克杯', size: 'auto', seedText: 's', referenceImages: [], indexInBatch: 0 })

    expect(calls[0].url).toBe('http://gw.example/v1/images/generations')
    const body = JSON.parse(String(calls[0].init?.body))
    expect(body).toEqual({ model: 'gpt-image-2', prompt: '白瓷马克杯', size: '1024x1024' })
    expect(body).not.toHaveProperty('response_format') // 该参数会导致上游失败
    expect(img.mimeType).toBe('image/png')
    expect(img.buffer.length).toBeGreaterThan(0)
    expect(img.width).toBe(1)
  })

  it('图生图：带参考图时走 images/edits multipart', async () => {
    const { fn, calls } = fakeFetch({ data: [{ b64_json: PNG_1PX.toString('base64') }] })
    const provider = new OpenAICompatProvider('http://gw.example/v1', 'sk-test', 'gpt-image-2', fn)
    const img = await provider.generate({
      prompt: '参考图风格',
      size: '1024x1024',
      seedText: 's',
      referenceImages: [{ buffer: PNG_1PX, mimeType: 'image/png' }],
      indexInBatch: 0,
    })

    expect(calls[0].url).toBe('http://gw.example/v1/images/edits')
    expect(calls[0].init?.body instanceof FormData).toBe(true)
    const form = calls[0].init?.body as FormData
    expect(form.get('model')).toBe('gpt-image-2')
    expect(form.get('prompt')).toBe('参考图风格')
    expect(form.get('image')).not.toBeNull() // 单参考图用 image 字段
    expect(img.mimeType).toBe('image/png')
  })

  it('接口错误抛出含状态码的异常', async () => {
    const { fn } = fakeFetch({ error: { message: 'Upstream request failed' } }, 502)
    const provider = new OpenAICompatProvider('http://gw.example/v1', 'sk-test', 'gpt-image-2', fn)
    await expect(
      provider.generate({ prompt: 'x', size: '1024x1024', seedText: 's', referenceImages: [], indexInBatch: 0 })
    ).rejects.toThrow(/502/)
  })
})

describe('createImageProviderFromEnv', () => {
  it('缺配置直接报错（不再降级 mock）', () => {
    expect(() => createImageProviderFromEnv({})).toThrow(/IMAGE_API_BASE_URL/)
    expect(() => createImageProviderFromEnv({ IMAGE_API_BASE_URL: 'http://gw.example/v1' })).toThrow(/IMAGE_API_KEY/)
  })
  it('配置齐全时创建 OpenAICompatProvider', () => {
    const p = createImageProviderFromEnv({
      IMAGE_API_BASE_URL: 'http://gw.example/v1',
      IMAGE_API_KEY: 'sk-x',
    })
    expect(p instanceof OpenAICompatProvider).toBe(true)
    expect(p.name).toBe('gpt-image-2')
  })
})
