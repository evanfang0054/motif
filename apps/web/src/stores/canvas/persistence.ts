/**
 * 画布持久化：双 driver + 防抖合并。
 *
 * 参考 `.infinite-canvas-ref/src/lib/localforage-storage.ts` 的降级思路
 * （主介质失败回退次介质、异常不外抛）。
 * 适配改动：介质由 localforage 改为 localStorage —— 依赖白名单限定「仅新增 zustand ^5」，
 * 而画布补丁只含位置与视口（无图片二进制），
 * 体量远小于 localforage 的适用场景。降级链：localStorage → 内存。
 *
 * 组合策略：内存为权威，拖拽零延迟；**结构变更立即提交**，
 * **位置变更防抖 400ms 合并提交**。
 */
import type { CanvasImagePlacement, CanvasMeta, CanvasPatch, CanvasSnapshot } from '@motif/core'
import { DEFAULT_CANVAS_META, normalizeCanvasMeta } from '@motif/core'

export interface CanvasPersistence {
  load(topicId: string): Promise<CanvasSnapshot | null>
  save(topicId: string, patch: CanvasPatch): Promise<{ applied: string[]; rejected: string[] }>
  /** 清掉该任务的本地草稿（重放成功 / 云端已是权威后调用）。内存兜底 driver 无此需要 */
  clear?(topicId: string): void
}

const LOCAL_KEY = (topicId: string) => `motif:canvas:${topicId}`

/** 内存兜底：localStorage 不可用（隐私模式/配额超限）时仍能编辑，只是不跨刷新 */
const memoryFallback = new Map<string, string>()

/** 本地草稿 driver：localStorage 优先，失败退化为内存 */
export function createLocalDriver(): CanvasPersistence {
  const readRaw = (topicId: string): string | null => {
    try {
      const v = globalThis.localStorage?.getItem(LOCAL_KEY(topicId))
      if (v !== null && v !== undefined) return v
    } catch {
      // 读失败：退内存
    }
    return memoryFallback.get(topicId) ?? null
  }

  const writeRaw = (topicId: string, value: string): void => {
    memoryFallback.set(topicId, value)
    try {
      globalThis.localStorage?.setItem(LOCAL_KEY(topicId), value)
    } catch {
      // 写失败：内存里那份仍是权威（本次会话内可用）
    }
  }

  return {
    async load(topicId) {
      const raw = readRaw(topicId)
      if (!raw) return null
      try {
        const parsed = JSON.parse(raw) as Partial<CanvasSnapshot>
        return { images: parsed.images ?? [], meta: normalizeCanvasMeta(parsed.meta) }
      } catch {
        return null
      }
    },
    async save(topicId, patch) {
      const current = (await this.load(topicId)) ?? { images: [], meta: DEFAULT_CANVAS_META }
      const byId = new Map(current.images.map((p) => [p.id, p]))
      for (const p of patch.images?.upsert ?? []) byId.set(p.id, p)
      const meta = patch.meta ? normalizeCanvasMeta({ ...current.meta, ...patch.meta }) : current.meta
      writeRaw(topicId, JSON.stringify({ images: [...byId.values()], meta } satisfies CanvasSnapshot))
      return { applied: (patch.images?.upsert ?? []).map((p) => p.id), rejected: [] }
    },
    clear(topicId) {
      memoryFallback.delete(topicId)
      try {
        globalThis.localStorage?.removeItem(LOCAL_KEY(topicId))
      } catch {
        // 删失败无所谓：下次成功加载时会被覆盖
      }
    },
  }
}

/** 云端 driver：调 `GET/PATCH /api/topics/[id]/canvas` */
export function createCloudDriver(): CanvasPersistence {
  return {
    async load(topicId) {
      const res = await fetch(`/api/topics/${topicId}/canvas`)
      if (!res.ok) return null
      const data = (await res.json()) as CanvasSnapshot
      return { images: data.images ?? [], meta: normalizeCanvasMeta(data.meta) }
    },
    async save(topicId, patch) {
      const res = await fetch(`/api/topics/${topicId}/canvas`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (!res.ok) throw new Error(`画布保存失败（${res.status}）`)
      const data = (await res.json()) as { applied: string[]; rejected: string[] }
      return { applied: data.applied ?? [], rejected: data.rejected ?? [] }
    },
  }
}

const EMPTY: { applied: string[]; rejected: string[] } = { applied: [], rejected: [] }

/** 组合层：driver + 单一防抖队列（位置与 meta 合并成一次 PATCH） */
export interface CanvasSync {
  load(topicId: string): Promise<CanvasSnapshot | null>
  /** 结构变更（增删图片/改尺寸）：立即提交，不参与防抖 */
  commitStructural(topicId: string, patch: CanvasPatch): Promise<{ applied: string[]; rejected: string[] }>
  /** 位置变更：进防抖队列；窗口结束时随合并补丁一起提交，返回值即 driver.save 的结果 */
  commitPlacement(topicId: string, placements: CanvasImagePlacement[]): Promise<{ applied: string[]; rejected: string[] }>
  /** 视口/背景变更：与位置共用同一条防抖队列（避免两次 PATCH）；失败不阻断编辑，故无返回值 */
  commitMeta(topicId: string, meta: Partial<CanvasMeta>): void
  /** 立即冲掉待提交队列（页面卸载 / 切任务前调用） */
  flush(): Promise<{ applied: string[]; rejected: string[] }>
  /** 离线队列：网络恢复后重放 */
  replayPending(topicId: string): Promise<{ applied: string[]; rejected: string[] }>
}

export function createCanvasPersistence(
  driver: CanvasPersistence,
  debounceMs = 400,
  draft?: CanvasPersistence
): CanvasSync {
  let timer: ReturnType<typeof setTimeout> | null = null
  let queued: {
    topicId: string
    placements: Map<string, CanvasImagePlacement>
    meta: Partial<CanvasMeta> | null
    resolvers: Array<(r: { applied: string[]; rejected: string[] }) => void>
  } | null = null
  /** 提交失败的位置（网络不可用）暂存于此，供 replayPending 重放 */
  const offline = new Map<string, Map<string, CanvasImagePlacement>>()

  const park = (topicId: string, list: CanvasImagePlacement[]): void => {
    const bucket = offline.get(topicId) ?? new Map<string, CanvasImagePlacement>()
    for (const p of list) bucket.set(p.id, p)
    offline.set(topicId, bucket)
  }

  /** 待重放队列同时写一份本地草稿：断网期间刷新页面也能看到自己刚摆的位置 */
  const parkAndDraft = (topicId: string, patch: CanvasPatch, list: CanvasImagePlacement[]): void => {
    park(topicId, list)
    if (draft && list.length > 0) {
      void draft.save(topicId, { images: { upsert: list } }).catch(() => {})
    }
  }

  const send = async (
    topicId: string,
    patch: CanvasPatch,
    placementsForParking: CanvasImagePlacement[]
  ): Promise<{ applied: string[]; rejected: string[] }> => {
    try {
      return await driver.save(topicId, patch)
    } catch {
      // 网络不可用（或服务端暂时报错）：位置进离线队列 + 落本地草稿，不阻断编辑
      parkAndDraft(topicId, patch, placementsForParking)
      return EMPTY
    }
  }

  const flushNow = async (): Promise<{ applied: string[]; rejected: string[] }> => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    const pending = queued
    queued = null
    if (!pending) return EMPTY
    const upserts = [...pending.placements.values()]
    const patch: CanvasPatch = {
      ...(upserts.length ? { images: { upsert: upserts } } : {}),
      ...(pending.meta ? { meta: pending.meta } : {}),
    }
    const res = await send(pending.topicId, patch, upserts)
    for (const r of pending.resolvers) r(res)
    return res
  }

  const schedule = (topicId: string, resolve?: (r: { applied: string[]; rejected: string[] }) => void): void => {
    if (!queued || queued.topicId !== topicId) {
      // 切任务：先把上一个任务的队列冲掉，避免把 A 任务的位置写到 B 任务
      void flushNow()
      queued = { topicId, placements: new Map(), meta: null, resolvers: [] }
    }
    if (resolve) queued.resolvers.push(resolve)
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      void flushNow()
    }, debounceMs)
  }

  return {
    async load(topicId) {
      const cloud = await driver.load(topicId).catch(() => null)
      // 本地草稿里可能留着上次断网时没提交成功的位置
      const pendingDraft = draft ? await draft.load(topicId).catch(() => null) : null
      const pendingImages = pendingDraft?.images ?? []
      if (!cloud) {
        // 云端不可用：把草稿里的位置记进待重放队列（本次会话网络恢复后能补交），
        // 返回值仍为 null —— 交给上层用本地草稿渲染并提示「本地草稿」
        if (pendingImages.length > 0) park(topicId, pendingImages)
        return null
      }
      if (pendingImages.length === 0) return cloud
      // 云端可用：用户上次的编辑比服务端快照新，叠加进来并补交
      park(topicId, pendingImages)
      const byId = new Map(cloud.images.map((p) => [p.id, p]))
      for (const p of pendingImages) byId.set(p.id, p)
      void this.replayPending(topicId)
      return { images: [...byId.values()], meta: cloud.meta }
    },
    async commitStructural(topicId, patch) {
      // 结构变更必须先于位置变更落库：否则「先删图、后提交旧位置」会让服务端收到
      // 已删除图片的位置补丁（虽会被判 rejected，但顺序乱了会多一次无谓往返）
      await flushNow()
      return send(topicId, patch, patch.images?.upsert ?? [])
    },
    commitPlacement(topicId, placements) {
      return new Promise((resolve) => {
        schedule(topicId, resolve)
        for (const p of placements) queued!.placements.set(p.id, p)
      })
    },
    commitMeta(topicId, meta) {
      schedule(topicId)
      queued!.meta = { ...(queued!.meta ?? {}), ...meta }
    },
    flush: flushNow,
    async replayPending(topicId) {
      const bucket = offline.get(topicId)
      if (!bucket || bucket.size === 0) return EMPTY
      const upserts = [...bucket.values()]
      try {
        const res = await driver.save(topicId, { images: { upsert: upserts } })
        offline.delete(topicId)
        draft?.clear?.(topicId) // 已补交：草稿清掉，避免下次被当成更新值覆盖服务端
        return res
      } catch {
        return EMPTY // 仍未恢复：队列与草稿都原样保留
      }
    },
  }
}
