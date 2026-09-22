import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MotifStore } from '@motif/db'
import { SETTING_DEFS, configHealth, resolveLlmReady } from '@/server/settings'

let dir: string
let store: MotifStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'motif-llmh-'))
  store = new MotifStore(join(dir, 'motif.db'))
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('llm 分组的键', () => {
  it('5 个键都在 llm 组，开关默认关闭', () => {
    const keys = SETTING_DEFS.filter((d) => d.group === 'llm').map((d) => d.key)
    expect(keys).toEqual(['LLM_ENHANCE_ENABLED', 'LLM_API_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL', 'LLM_TIMEOUT_MS'])
    expect(SETTING_DEFS.find((d) => d.key === 'LLM_ENHANCE_ENABLED')!.defaultHint).toBe('false')
  })

  it('端点与密钥标为 required，密钥是 secret', () => {
    expect(SETTING_DEFS.find((d) => d.key === 'LLM_API_BASE_URL')!.required).toBe(true)
    expect(SETTING_DEFS.find((d) => d.key === 'LLM_API_KEY')!.required).toBe(true)
    expect(SETTING_DEFS.find((d) => d.key === 'LLM_API_KEY')!.kind).toBe('secret')
  })

  it('新键既非 readOnly 也非 danger（既有精确集合断言不破）', () => {
    const bad = SETTING_DEFS.filter((d) => d.group === 'llm' && (d.readOnly || d.danger))
    expect(bad).toEqual([])
  })
})

describe('llm 就绪判定', () => {
  const enable = (extra: Array<{ key: string; value: string }> = []) =>
    store.setSettings([{ key: 'LLM_ENHANCE_ENABLED', value: 'true' }, ...extra])

  it('开关关闭时：就绪判 false，且 configHealth 不算未就绪（未启用不是配置缺失）', () => {
    expect(resolveLlmReady(store, {})).toBe(false)
    expect(configHealth(store, {}).find((h) => h.group === 'llm')!.ready).toBe(true)
  })

  it('开关开但缺端点/密钥：就绪判 false，configHealth 报未就绪并给出原因', () => {
    enable()
    expect(resolveLlmReady(store, {})).toBe(false)
    const h = configHealth(store, {}).find((x) => x.group === 'llm')!
    expect(h.ready).toBe(false)
    expect(h.reason).toMatch(/LLM_API_BASE_URL|LLM_API_KEY/)
  })

  it('开关开且三项齐备：就绪判 true，configHealth 就绪', () => {
    enable([
      { key: 'LLM_API_BASE_URL', value: 'https://llm.example.com/v1' },
      { key: 'LLM_API_KEY', value: 'sk-placeholder' },
    ])
    expect(resolveLlmReady(store, {})).toBe(true)
    expect(configHealth(store, {}).find((h) => h.group === 'llm')!.ready).toBe(true)
  })

  it('只有端点没有密钥仍不算就绪（必填是两项都算）', () => {
    enable([{ key: 'LLM_API_BASE_URL', value: 'https://llm.example.com/v1' }])
    expect(resolveLlmReady(store, {})).toBe(false)
  })
})
