import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MotifStore } from '@motif/db'
import { enqueueGeneration } from '@/server/services'
import type { GeneratedImage, ImageProvider } from '@motif/image-provider'

/**
 * 增强接线：服务端权威判定（前端意愿只是请求）、失败降级为原文、额度不受影响。
 * 全用 stub fetch，不出网。
 */
let dir: string
let store: MotifStore
const provider: ImageProvider = {
  name: 'stub',
  generate: async (): Promise<GeneratedImage> => ({ buffer: Buffer.from('stub'), mimeType: 'image/png', width: 1, height: 1 }),
}
const base = { count: 1, size: '1024x1024', topicId: null, referenceCanvasImageIds: [] as string[] }

function newUser(email: string, credits = 8) {
  return store.createUser({ email, passwordHash: 'h', name: 'u', credits })
}
function enableLlm() {
  store.setSettings([
    { key: 'LLM_ENHANCE_ENABLED', value: 'true' },
    { key: 'LLM_API_BASE_URL', value: 'https://llm.example.com/v1' },
    { key: 'LLM_API_KEY', value: 'sk-placeholder' },
  ])
}
const okResponse = () =>
  new Response(JSON.stringify({ choices: [{ message: { content: '一只白瓷马克杯，晨光侧逆光，浅景深，极简背景' } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'motif-llm-'))
  store = new MotifStore(join(dir, 'motif.db'))
  vi.restoreAllMocks()
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

describe('提示词增强接线', () => {
  it('开关关闭时不发起任何 LLM 请求，finalPrompt 等于原文', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const u = newUser('off@b.co')
    const r = await enqueueGeneration(store, provider, dir, u, { ...base, prompt: '白瓷马克杯', enhance: true })
    expect(fetchSpy).not.toHaveBeenCalled()
    const msg = store.getMessage(r.messageId)!
    expect(msg.finalPrompt).toBe('白瓷马克杯')
    expect(msg.enhancePrompt).toBe(false)
  })

  it('开关开但未配齐时也不调用 LLM（视为未就绪）', async () => {
    store.setSetting('LLM_ENHANCE_ENABLED', 'true')
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const u = newUser('notready@b.co')
    const r = await enqueueGeneration(store, provider, dir, u, { ...base, prompt: '白瓷马克杯', enhance: true })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(store.getMessage(r.messageId)!.finalPrompt).toBe('白瓷马克杯')
  })

  it('开启且就绪时 finalPrompt 为增强结果，enhance_prompt 记为真', async () => {
    enableLlm()
    vi.stubGlobal('fetch', vi.fn(async () => okResponse()))
    const u = newUser('on@b.co')
    const r = await enqueueGeneration(store, provider, dir, u, { ...base, prompt: '白瓷马克杯', enhance: true })
    const msg = store.getMessage(r.messageId)!
    expect(msg.finalPrompt).toBe('一只白瓷马克杯，晨光侧逆光，浅景深，极简背景')
    expect(msg.enhancePrompt).toBe(true)
  })

  it('LLM 失败时降级为原文、enhance_prompt 为假、额度按张预扣（不退不补）', async () => {
    enableLlm()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('网关 502') }))
    const u = newUser('fail@b.co', 8)
    const r = await enqueueGeneration(store, provider, dir, u, { ...base, prompt: '白瓷马克杯', enhance: true })
    const msg = store.getMessage(r.messageId)!
    expect(msg.finalPrompt).toBe('白瓷马克杯')
    expect(msg.enhancePrompt).toBe(false)
    expect(store.getUserById(u.id)!.credits).toBe(7)
  })

  it('前端传 enhance 但服务端未开启时，服务端仍不调用（双保险）', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const u = newUser('double@b.co')
    await enqueueGeneration(store, provider, dir, u, { ...base, prompt: '白瓷马克杯', enhance: true })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('前端没请求增强时，即使配置齐备也不调用 LLM', async () => {
    enableLlm()
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const u = newUser('noreq@b.co')
    const r = await enqueueGeneration(store, provider, dir, u, { ...base, prompt: '白瓷马克杯', enhance: false })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(store.getMessage(r.messageId)!.enhancePrompt).toBe(false)
  })

  it('三种路径的扣费一致（额度不因是否增强而变化）', async () => {
    enableLlm()
    vi.stubGlobal('fetch', vi.fn(async () => okResponse()))
    const on = newUser('c1@b.co', 8)
    await enqueueGeneration(store, provider, dir, on, { ...base, prompt: '白瓷马克杯', enhance: true })
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('boom') }))
    const fail = newUser('c2@b.co', 8)
    await enqueueGeneration(store, provider, dir, fail, { ...base, prompt: '白瓷马克杯', enhance: true })
    vi.stubGlobal('fetch', vi.fn())
    const off = newUser('c3@b.co', 8)
    await enqueueGeneration(store, provider, dir, off, { ...base, prompt: '白瓷马克杯', enhance: false })
    expect([
      store.getUserById(on.id)!.credits,
      store.getUserById(fail.id)!.credits,
      store.getUserById(off.id)!.credits,
    ]).toEqual([7, 7, 7])
  })

  it('⚠️ 回归：增强必须发生在**扣费之前** —— 否则「扣费后、建消息前」的不守恒窗口被拉长到最长 20s', async () => {
    // 不守恒窗口 = deductCredits 之后、createMessage 之前：退额只发生在 executeMessage 的
    // catch / finishCancel 里，两者都要求消息已存在。进程若在这个窗口里被 kill，额度已扣却
    // 没有消息行，worker 永远不会退这笔钱。增强是一次最长 20s 的网络调用，绝不能落在这个窗口里。
    // 可观测的判据：额度不足（402）时**已经**调过 LLM —— 说明增强排在扣费检查之前。
    enableLlm()
    const fetchMock = vi.fn(async () => okResponse())
    vi.stubGlobal('fetch', fetchMock)
    const broke = newUser('broke@b.co', 0)
    await expect(enqueueGeneration(store, provider, dir, broke, { ...base, prompt: '白瓷马克杯', enhance: true })).rejects.toThrow(
      /额度不足/
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // 且没有产生任何消息（额度不足不该建任务消息）
    expect(store.listMessages(store.createTopic(broke.id, 'x').id)).toEqual([])
  })
})
