/**
 * 画布 store：图片位置、选中集、视口、撤销栈。
 *
 * 参考 `.infinite-canvas-ref/src/stores/canvas/use-canvas-store.ts` 的状态组织
 * （单一 project 承载 nodes + viewport + backgroundMode）。
 * 适配改动：上游的 nodes 是完整节点数组、持久化走 zustand persist + localforage；
 * Motif 的 placements 只是「id → 矩形」的稀疏表（图片本体来自 topic detail），
 * 持久化走 `persistence.ts` 的双 driver（云端为权威）。
 */
'use client'

import { create } from 'zustand'
import type { CanvasBackgroundMode, CanvasImagePlacement, CanvasMeta, CanvasSnapshot } from '@motif/core'
import { DEFAULT_CANVAS_META } from '@motif/core'
import type { Rect } from '@/lib/canvas/geometry'
import { createCanvasHistory, type CanvasHistory } from '@/lib/canvas/history'
import { allocateSlots, displaySize, placementRect, rectToPlacement } from '@/lib/canvas/placement'
import { clampScale, panBy, zoomAt as zoomAtViewport, type Viewport } from '@/lib/canvas/viewport'

type Placements = Record<string, Rect>

/** `syncImages` 需要的最小图片信息：id + 服务端落库的摆放 + 原图像素尺寸 */
export interface CanvasSyncImage {
  id: string
  canvasX: number
  canvasY: number
  canvasWidth: number
  canvasHeight: number
  /** 原图像素宽高（服务端摆放缺失时用它算显示尺寸） */
  width: number
  height: number
}

/**
 * 把历史快照叠加回当前摆放（撤销/重做的唯一入口）。
 *
 * ⚠️ **不能直接返回快照** —— 快照是「手势开始时那一整份 placements」，直接用它替换会让
 * 期间发生的两件事出错：
 * 1. **复活已删除的图**（服务端删除不可撤销，历史里仍留着它的矩形）；
 * 2. **抹掉新生成的图**（快照里根本没有它）。
 * 故以**当前**摆放为底，只对「两边都存在且矩形确实不同」的 id 回滚矩形。
 *
 * ⚠️ 只把**真正变了的** id 计入 dirty：否则一次撤销会把整画布所有图都打上最新时间戳推回服务端，
 * 按图片级「后来者胜」会覆盖其它标签页对这些图的最新位置 —— 用户只按了一次撤销，却赢了别人的改动。
 */
function restore(current: Placements, snapshot: Placements): { placements: Placements; dirty: string[] } {
  const placements: Placements = { ...current }
  const touched: string[] = []
  for (const id of Object.keys(current)) {
    const snap = snapshot[id]
    if (!snap) continue
    const cur = current[id]
    if (cur && cur.x === snap.x && cur.y === snap.y && cur.w === snap.w && cur.h === snap.h) continue
    placements[id] = snap
    touched.push(id)
  }
  return { placements, dirty: touched }
}

export interface CanvasState {
  topicId: string | null
  placements: Placements
  meta: CanvasMeta
  selected: string[]
  /** 'cloud' = 云端已同步；'local' = 离线草稿（画布上提示"本地草稿"） */
  source: 'cloud' | 'local'
  /** 撤销栈（非响应式；放 store 里以便工具栏直接复用） */
  history: CanvasHistory<Placements>
  /** 待提交的位置（由 CanvasStage 防抖提交；store 只记录） */
  dirty: string[]

  init(topicId: string, snapshot: CanvasSnapshot, source: 'cloud' | 'local'): void
  /**
   * 图片集合变化：清掉已不存在的摆放与选中，并**给新出现的图补上摆放**（**不进撤销栈** —— 删除不可撤销）。
   *
   * ⚠️ 补位必须做，否则「首批之后生成的图」永远不会出现在画布上：快照只在挂载时取一次，
   * 之后 detail 刷新带来的新 id 在 placements 里没有条目，渲染层会直接跳过它（顶部计数却已含它）。
   * 优先级：本地已有摆放（可能是用户刚拖的、还没落库）> 服务端落库的摆放（生成产出与转正参考都带）
   * > 本地按空位槽分配（老行未补位 / 快照接口失败时的兜底），后者要落库。
   */
  syncImages(images: CanvasSyncImage[], origin: { x: number; y: number }): void

  beginGesture(key: string): void
  endGesture(): void
  /** 作废当前手势（点了但没拖动）：不入撤销栈，避免空步吃掉一次 Ctrl+Z */
  cancelGesture(): void
  moveBy(ids: string[], dx: number, dy: number): void
  /** 手动改尺寸（本批无拖拽缩放手柄，仅 API 级；经此路径保证撤销覆盖尺寸） */
  resizeTo(id: string, width: number, height: number): void
  undo(): void
  redo(): void
  /** 服务端拒了更旧的写入：用服务端快照覆盖本地对应 id 的摆放并清出 dirty */
  applyServerPlacements(serverPlacements: CanvasImagePlacement[]): void
  /** 批量覆盖摆放（「整理布局」用）：全部进 dirty，由防抖提交落库 */
  applyPlacements(next: CanvasImagePlacement[]): void

  setViewport(v: Viewport): void
  zoomAt(factor: number, anchorX: number, anchorY: number): void
  panBy(dx: number, dy: number): void
  /** 背景图案三态：只改 `meta.background`，**不动 viewport / version** */
  setBackground(background: CanvasBackgroundMode): void

  setSelected(ids: string[]): void
  toggleSelect(id: string): void
  clearSelection(): void

  /** 取出「脏」的摆放，供 CanvasStage 提交后清账 */
  takeDirty(): CanvasImagePlacement[]
  markClean(ids: string[]): void
}

export function createCanvasStore() {
  return create<CanvasState>()((set, get) => ({
    topicId: null,
    placements: {},
    meta: { ...DEFAULT_CANVAS_META },
    selected: [],
    source: 'cloud',
    history: createCanvasHistory<Placements>(),
    dirty: [],

    init(topicId, snapshot, source) {
      const placements: Placements = {}
      for (const p of snapshot.images) placements[p.id] = placementRect(p)
      set({
        topicId,
        placements,
        meta: snapshot.meta,
        selected: [],
        source,
        history: createCanvasHistory<Placements>(),
        dirty: [],
      })
    },

    syncImages(images, origin) {
      set((s) => {
        const next: Placements = {}
        const unplaced: CanvasSyncImage[] = []
        for (const img of images) {
          const existing = s.placements[img.id]
          if (existing) {
            next[img.id] = existing
            continue
          }
          // 服务端已落库的摆放（生成产出、转正参考、旧库补位都会带）
          if (img.canvasWidth > 0 && img.canvasHeight > 0) {
            next[img.id] = { x: img.canvasX, y: img.canvasY, w: img.canvasWidth, h: img.canvasHeight }
            continue
          }
          unplaced.push(img)
        }
        // 兜底：没有服务端摆放的图（老行未补位，或快照接口失败）按空位槽就地分配，并落库
        if (unplaced.length > 0) {
          const slots = allocateSlots(
            Object.values(next),
            unplaced.map((i) => displaySize(i.width, i.height)),
            origin
          )
          unplaced.forEach((img, i) => {
            if (slots[i]) next[img.id] = slots[i]
          })
        }
        return {
          placements: next,
          selected: s.selected.filter((id) => next[id] !== undefined),
          dirty: [...new Set([...s.dirty, ...unplaced.map((i) => i.id).filter((id) => next[id] !== undefined)])],
          // ⚠️ 刻意不动 history：服务端删除不可撤销
        }
      })
    },

    beginGesture(key) {
      const s = get()
      s.history.begin(key, s.placements)
    },
    endGesture() {
      get().history.commit()
    },
    cancelGesture() {
      get().history.cancel()
    },
    moveBy(ids, dx, dy) {
      set((s) => {
        const next: Placements = { ...s.placements }
        for (const id of ids) {
          const r = next[id]
          if (!r) continue
          next[id] = { ...r, x: r.x + dx, y: r.y + dy }
        }
        return { placements: next, dirty: [...new Set([...s.dirty, ...ids])] }
      })
    },
    resizeTo(id, width, height) {
      set((s) => {
        const r = s.placements[id]
        if (!r) return s
        return { placements: { ...s.placements, [id]: { ...r, w: width, h: height } }, dirty: [...new Set([...s.dirty, id])] }
      })
    },
    undo() {
      set((s) => {
        const prev = s.history.undo(s.placements)
        if (!prev) return s
        return restore(s.placements, prev)
      })
    },
    redo() {
      set((s) => {
        const next = s.history.redo(s.placements)
        if (!next) return s
        return restore(s.placements, next)
      })
    },

    setViewport(v) {
      set((s) => ({ meta: { ...s.meta, viewport: { ...v, k: clampScale(v.k) } } }))
    },
    zoomAt(factor, anchorX, anchorY) {
      set((s) => ({ meta: { ...s.meta, viewport: zoomAtViewport(s.meta.viewport, factor, anchorX, anchorY) } }))
    },
    panBy(dx, dy) {
      set((s) => ({ meta: { ...s.meta, viewport: panBy(s.meta.viewport, dx, dy) } }))
    },
    setBackground(background) {
      // 落库零新增管线：meta 变化由 CanvasStage 的 [meta] effect → commitMeta → 400ms 防抖队列 → PATCH 完成
      set((s) => ({ meta: { ...s.meta, background } }))
    },

    setSelected(ids) {
      set({ selected: [...new Set(ids)] })
    },
    toggleSelect(id) {
      set((s) => ({ selected: s.selected.includes(id) ? s.selected.filter((x) => x !== id) : [...s.selected, id] }))
    },
    clearSelection() {
      set((s) => (s.selected.length ? { selected: [] } : s))
    },

    takeDirty() {
      const s = get()
      const now = new Date().toISOString()
      return s.dirty.flatMap((id) => {
        const r = s.placements[id]
        return r ? [rectToPlacement(id, r, now)] : []
      })
    },
    markClean(ids) {
      set((s) => ({ dirty: s.dirty.filter((id) => !ids.includes(id)) }))
    },
    applyServerPlacements(serverPlacements) {
      // 服务端拒了这些 id（库中版本更新 / 图已删除）：用服务端快照覆盖本地并清出 dirty，
      // 避免本地继续拿着更旧的值反复重试（用服务端返回值覆盖本地并提示）。
      set((s) => {
        const next: Placements = { ...s.placements }
        const touched: string[] = []
        for (const p of serverPlacements) {
          if (!(p.id in next)) continue
          next[p.id] = placementRect(p)
          touched.push(p.id)
        }
        return { placements: next, dirty: s.dirty.filter((id) => !touched.includes(id)) }
      })
    },
    applyPlacements(next) {
      set((s) => {
        const placements: Placements = { ...s.placements }
        const ids: string[] = []
        for (const p of next) {
          placements[p.id] = placementRect(p)
          ids.push(p.id)
        }
        return { placements, dirty: [...new Set([...s.dirty, ...ids])] }
      })
    },
  }))
}

export const useCanvasStore = createCanvasStore()
