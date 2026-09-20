import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCanvasPersistence, createCloudDriver, createLocalDriver, type CanvasPersistence } from '@/stores/canvas/persistence'
import type { CanvasPatch, CanvasSnapshot } from '@motif/core'
import { DEFAULT_CANVAS_META } from '@motif/core'

function fakeDriver(): CanvasPersistence & { saves: CanvasPatch[] } {
  const saves: CanvasPatch[] = []
  return {
    saves,
    load: async (): Promise<CanvasSnapshot | null> => ({ images: [], meta: DEFAULT_CANVAS_META }),
    save: async (_topicId: string, patch: CanvasPatch) => {
      saves.push(patch)
      return { applied: patch.images?.upsert?.map((p) => p.id) ?? [], rejected: [] }
    },
  }
}

const p = (id: string, updatedAt = '2026-09-20T10:00:00.000Z') => ({
  id, canvasX: 1, canvasY: 2, canvasWidth: 240, canvasHeight: 240, updatedAt,
})

describe('防抖合并（L3-1-G2-A1）', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('连续拖拽 20 次仅产生 1 次 PATCH 调用', async () => {
    const driver = fakeDriver()
    const cp = createCanvasPersistence(driver, 400)
    let last: Promise<{ applied: string[]; rejected: string[] }> = Promise.resolve({ applied: [], rejected: [] })
    for (let i = 0; i < 20; i += 1) {
      last = cp.commitPlacement('top_1', [p('cimg_a', `2026-09-20T10:00:${String(i).padStart(2, '0')}.000Z`)])
    }
    expect(driver.saves).toHaveLength(0) // 防抖窗口内零提交
    await vi.advanceTimersByTimeAsync(400)
    await last
    expect(driver.saves).toHaveLength(1)
    // 提交的是最后一次的值（合并语义：后写覆盖）
    expect(driver.saves[0].images?.upsert?.[0].updatedAt).toBe('2026-09-20T10:00:19.000Z')
  })

  it('不同图片的位置变更在同一窗口内合并为一次提交', async () => {
    const driver = fakeDriver()
    const cp = createCanvasPersistence(driver, 400)
    void cp.commitPlacement('top_1', [p('cimg_a')])
    const last = cp.commitPlacement('top_1', [p('cimg_b')])
    await vi.advanceTimersByTimeAsync(400)
    await last
    expect(driver.saves).toHaveLength(1)
    expect(driver.saves[0].images?.upsert?.map((x) => x.id).sort()).toEqual(['cimg_a', 'cimg_b'])
  })

  it('driver 层合并后真实 PATCH 只有 1 次（断言 fetch 次数）', async () => {
    vi.useRealTimers()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ applied: ['cimg_a'], rejected: [] }), { status: 200 })
    )
    try {
      const cp = createCanvasPersistence(createCloudDriver(), 10)
      let last: Promise<unknown> = Promise.resolve()
      for (let i = 0; i < 20; i += 1) last = cp.commitPlacement('top_1', [p('cimg_a')])
      await last
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    } finally {
      fetchSpy.mockRestore()
    }
  })
})

describe('结构变更立即提交（L3-1-G2-A2）', () => {
  it('不参与防抖，立刻发出', async () => {
    const driver = fakeDriver()
    const cp = createCanvasPersistence(driver, 400)
    await cp.commitStructural('top_1', { images: { upsert: [p('cimg_a')] } })
    expect(driver.saves).toHaveLength(1)
  })

  it('结构变更前会先把待提交的位置冲掉（顺序不乱）', async () => {
    vi.useFakeTimers()
    const driver = fakeDriver()
    const cp = createCanvasPersistence(driver, 400)
    void cp.commitPlacement('top_1', [p('cimg_a')])
    await cp.commitStructural('top_1', { images: { upsert: [p('cimg_b')] } })
    expect(driver.saves).toHaveLength(2)
    expect(driver.saves[0].images?.upsert?.[0].id).toBe('cimg_a')
    expect(driver.saves[1].images?.upsert?.[0].id).toBe('cimg_b')
    vi.useRealTimers()
  })
})

describe('rejected 透传（服务端拒绝时原样回传）', () => {
  it('commitPlacement 把 driver 的 rejected 原样返回给调用方', async () => {
    vi.useFakeTimers()
    const driver: CanvasPersistence = {
      load: async () => null,
      save: async () => ({ applied: [], rejected: ['cimg_a'] }),
    }
    const cp = createCanvasPersistence(driver, 400)
    const pending = cp.commitPlacement('top_1', [p('cimg_a')])
    await vi.advanceTimersByTimeAsync(400)
    expect(await pending).toEqual({ applied: [], rejected: ['cimg_a'] })
    vi.useRealTimers()
  })
})

describe('离线草稿重放（网络恢复后补交）', () => {
  it('网络不可用时位置进离线队列、不抛错；恢复后 replayPending 重放成功', async () => {
    vi.useFakeTimers()
    let online = false
    const saved: CanvasPatch[] = []
    const driver: CanvasPersistence = {
      load: async () => null,
      save: async (_t, patch) => {
        if (!online) throw new Error('offline')
        saved.push(patch)
        return { applied: patch.images?.upsert?.map((x) => x.id) ?? [], rejected: [] }
      },
    }
    const cp = createCanvasPersistence(driver, 400)

    // 断网：提交不抛错、不入库
    const pending = cp.commitPlacement('top_1', [p('cimg_a')])
    await vi.advanceTimersByTimeAsync(400)
    expect(await pending).toEqual({ applied: [], rejected: [] })
    expect(saved).toHaveLength(0)

    // 恢复：重放
    online = true
    const replayed = await cp.replayPending('top_1')
    expect(replayed.applied).toEqual(['cimg_a'])
    expect(saved).toHaveLength(1)
    expect(saved[0].images?.upsert?.[0].id).toBe('cimg_a')

    // 队列已清空：再重放是空操作
    expect(await cp.replayPending('top_1')).toEqual({ applied: [], rejected: [] })
    expect(saved).toHaveLength(1)
    vi.useRealTimers()
  })

  it('仍未恢复时重放保留队列（不丢草稿）', async () => {
    vi.useFakeTimers()
    const driver: CanvasPersistence = {
      load: async () => null,
      save: async () => {
        throw new Error('offline')
      },
    }
    const cp = createCanvasPersistence(driver, 400)
    const pending = cp.commitPlacement('top_1', [p('cimg_a')])
    await vi.advanceTimersByTimeAsync(400)
    await pending
    expect(await cp.replayPending('top_1')).toEqual({ applied: [], rejected: [] })
    expect(await cp.replayPending('top_1')).toEqual({ applied: [], rejected: [] }) // 队列还在，只是仍失败
    vi.useRealTimers()
  })
})

describe('本地草稿真的会被写入（断网刷新后仍看得到自己摆的位置）', () => {
  /** 记录调用、可切换在线状态的草稿 driver */
  function fakeDraft() {
    const saves: CanvasPatch[] = []
    const clears: string[] = []
    let stored: CanvasSnapshot | null = null
    const draft: CanvasPersistence = {
      load: async () => stored,
      save: async (_t, patch) => {
        saves.push(patch)
        const byId = new Map((stored?.images ?? []).map((x) => [x.id, x]))
        for (const x of patch.images?.upsert ?? []) byId.set(x.id, x)
        stored = { images: [...byId.values()], meta: stored?.meta ?? DEFAULT_CANVAS_META }
        return { applied: patch.images?.upsert?.map((x) => x.id) ?? [], rejected: [] }
      },
      clear: (topicId) => {
        clears.push(topicId)
        stored = null
      },
    }
    return { draft, saves, clears, peek: () => stored }
  }

  it('提交失败时同时写本地草稿，且草稿里能看到那张图的新位置', async () => {
    vi.useFakeTimers()
    const driver: CanvasPersistence = { load: async () => null, save: async () => { throw new Error('offline') } }
    const { draft, saves, peek } = fakeDraft()
    const cp = createCanvasPersistence(driver, 400, draft)
    const pending = cp.commitPlacement('top_1', [p('cimg_a')])
    await vi.advanceTimersByTimeAsync(400)
    await pending
    expect(saves).toHaveLength(1)
    expect(peek()?.images.map((x) => x.id)).toEqual(['cimg_a'])
    vi.useRealTimers()
  })

  it('重放成功后清掉草稿（避免下次被当成更新值盖掉服务端）', async () => {
    vi.useFakeTimers()
    let online = false
    const driver: CanvasPersistence = {
      load: async () => null,
      save: async (_t, patch) => {
        if (!online) throw new Error('offline')
        return { applied: patch.images?.upsert?.map((x) => x.id) ?? [], rejected: [] }
      },
    }
    const { draft, clears, peek } = fakeDraft()
    const cp = createCanvasPersistence(driver, 400, draft)
    const pending = cp.commitPlacement('top_1', [p('cimg_a')])
    await vi.advanceTimersByTimeAsync(400)
    await pending
    expect(peek()).not.toBeNull()

    online = true
    await cp.replayPending('top_1')
    expect(clears).toEqual(['top_1'])
    expect(peek()).toBeNull()
    vi.useRealTimers()
  })

  it('下次加载：云端可用时把草稿里未提交的位置叠加进来并补交', async () => {
    const serverImages: CanvasPatch[] = []
    const driver: CanvasPersistence = {
      // 服务端快照里 a 还在旧位置
      load: async () => ({
        images: [{ id: 'cimg_a', canvasX: 0, canvasY: 0, canvasWidth: 240, canvasHeight: 240, updatedAt: 't1' }],
        meta: DEFAULT_CANVAS_META,
      }),
      save: async (_t, patch) => {
        serverImages.push(patch)
        return { applied: patch.images?.upsert?.map((x) => x.id) ?? [], rejected: [] }
      },
    }
    const { draft, clears } = fakeDraft()
    // 上次断网留下的草稿：a 已被拖到 x=500
    await draft.save('top_1', { images: { upsert: [p('cimg_a')] } })

    const cp = createCanvasPersistence(driver, 400, draft)
    const snap = await cp.load('top_1')
    // 草稿里的位置比服务端新 → 叠加后返回给调用方
    expect(snap?.images[0].canvasX).toBe(1)
    // 并补交给服务端，成功后清草稿
    await Promise.resolve()
    expect(serverImages).toHaveLength(1)
    expect(clears).toEqual(['top_1'])
  })

  it('云端不可用时返回 null（交上层用草稿渲染并提示「本地草稿」），但把草稿记进待重放队列', async () => {
    let online = false
    const replayed: CanvasPatch[] = []
    const driver: CanvasPersistence = {
      load: async () => {
        if (!online) throw new Error('offline')
        return { images: [], meta: DEFAULT_CANVAS_META }
      },
      save: async (_t, patch) => {
        replayed.push(patch)
        return { applied: patch.images?.upsert?.map((x) => x.id) ?? [], rejected: [] }
      },
    }
    const { draft } = fakeDraft()
    await draft.save('top_1', { images: { upsert: [p('cimg_a')] } })
    const cp = createCanvasPersistence(driver, 400, draft)

    expect(await cp.load('top_1')).toBeNull()
    online = true
    const res = await cp.replayPending('top_1')
    expect(res.applied).toEqual(['cimg_a'])
    expect(replayed).toHaveLength(1)
  })
})

describe('flush', () => {
  it('立即冲掉待提交队列', async () => {
    vi.useFakeTimers()
    const driver = fakeDriver()
    const cp = createCanvasPersistence(driver, 400)
    void cp.commitPlacement('top_1', [p('cimg_a')])
    await cp.flush()
    expect(driver.saves).toHaveLength(1)
    vi.useRealTimers()
  })
})

describe('本地 driver 降级（主介质不可用时退内存）', () => {
  it('localStorage 不可用时退化为内存，不抛错', async () => {
    const original = globalThis.localStorage
    // 模拟隐私模式：写入抛错
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => null,
        setItem: () => { throw new Error('QuotaExceededError') },
        removeItem: () => {},
      },
    })
    try {
      const driver = createLocalDriver()
      await expect(driver.save('top_1', { images: { upsert: [p('cimg_a')] } })).resolves.toEqual({
        applied: ['cimg_a'],
        rejected: [],
      })
      // 内存兜底：同进程内能读回
      const snap = await driver.load('top_1')
      expect(snap?.images.map((x) => x.id)).toEqual(['cimg_a'])
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: original })
    }
  })
})
