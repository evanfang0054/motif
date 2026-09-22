import { describe, expect, it } from 'vitest'
import { createLlmFromConfig } from '@/server/llm'

describe('createLlmFromConfig（必填才启用）', () => {
  it('端点与密钥齐备时能构造', () => {
    const llm = createLlmFromConfig({ LLM_API_BASE_URL: 'https://llm.example.com/v1', LLM_API_KEY: 'sk-placeholder' })
    expect(typeof llm.enhance).toBe('function')
  })

  it('缺端点或缺密钥时抛错（不可用时不许静默构造）', () => {
    expect(() => createLlmFromConfig({ LLM_API_KEY: 'sk-placeholder' })).toThrow(/LLM_API_BASE_URL/)
    expect(() => createLlmFromConfig({ LLM_API_BASE_URL: 'https://llm.example.com/v1' })).toThrow(/LLM_API_KEY/)
    expect(() => createLlmFromConfig({})).toThrow()
  })
})
