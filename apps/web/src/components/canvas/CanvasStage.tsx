/**
 * 画布视口容器：世界层变换（平移/缩放）+ 背景图案 + 框选/拖拽/撤销。
 *
 * 参考 `.infinite-canvas-ref/src/components/canvas/infinite-canvas.tsx` 的整体结构
 * （外层容器接管 wheel/pointer、内层世界层用 transform 承载节点、独立一层画背景网格）。
 * 适配改动：
 *  - 只渲染图片节点；连线、小地图、右键菜单、快捷键表、复制粘贴留 P2
 *  - 弹层豁免选择器由上游的 `.ant-*` 改为 `[data-canvas-no-zoom]` / `[role="dialog"]`（Motif 用 HeroUI）
 *  - 底色取 `var(--canvas-background)`（中性，不抄上游的暖底）
 *
 * ⚠️ 保留既有 CanvasBoard 的**全部**控件与文案（用户 2026-09-20 裁决 J1）：
 * 顶部 pill（张数 / 已选 / 清空选择）、整理布局、单选工具栏（放大预览 / @ 引用 / 下载 / 删除）、
 * 多选工具栏（已选 N 张 / 批量删除）、缩放条（−/百分比/＋/适应）、sr-only 清单、灯箱。
 * 唯一的语义变化：**整理布局**从「重置到网格」升级为「重排进空位槽并落库」。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, ButtonGroup, Dropdown, Label, Modal, ToggleButton, ToggleButtonGroup, Toolbar } from '@heroui/react'
import type { CanvasBackgroundMode, CanvasImage, CanvasImagePlacement, CanvasMeta } from '@motif/core'
import { anchorRender } from '@/components/ui/anchor-button'
import { boundsOf, hitTest, toWorld } from '@/lib/canvas/geometry'
import { backgroundGesture } from '@/lib/canvas/gesture'
import { gridStyle } from '@/lib/canvas/grid'
import { zipEntriesFor, zipEntryName, zipFileName } from '@/lib/canvas/download'
import { buildZip, readZip } from '@/lib/zip'
import { canvasArchiveEntries, mergeImportedPlacements, parseCanvasArchive } from '@/lib/canvas/archive'
import { allocateSlots, displaySize, rectToPlacement, viewportOrigin } from '@/lib/canvas/placement'
import { createCloudDriver, createLocalDriver, createCanvasPersistence, type CanvasSync } from '@/stores/canvas/persistence'
import { MiniMap } from './MiniMap'
import { CanvasContextMenu, type ContextMenuAction } from './CanvasContextMenu'
import { useCanvasStore } from '@/stores/canvas/useCanvasStore'
import { ZOOM_STEP, fitView, toolbarAnchor } from '@/lib/canvas/viewport'
import { isTypingTarget, shortcutFor } from '@/lib/canvas/shortcuts'
import { showToast } from '@/components/ui/toast'

const CLICK_THRESHOLD = 3

/**
 * 背景图案三态。取值域与默认值见 `@motif/core` 的 `CanvasBackgroundMode` / `DEFAULT_CANVAS_META`。
 * 文案照抄上游 `.infinite-canvas-ref/src/components/canvas/canvas-toolbar.tsx` 的 zh-CN 词条
 * （点 / 线 / 空白），分组标题「网格样式」同源；上游用 AntD Segmented，这里按 HeroUI 重写。
 */
const BACKGROUND_OPTIONS: Array<{ key: CanvasBackgroundMode; label: string }> = [
  { key: 'dots', label: '点' },
  { key: 'lines', label: '线' },
  { key: 'blank', label: '空白' },
]

interface Props {
  topicId: string
  images: CanvasImage[]
  onRemoveImages: (imgs: CanvasImage[]) => void
  /** 加入参考图（单张与批量共用；批量时一次写多句 #编号） */
  onAddReferences: (imgs: CanvasImage[]) => void
}

function CanvasStage({ topicId, images, onRemoveImages, onAddReferences }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [preview, setPreview] = useState<CanvasImage | null>(null)
  const [marquee, setMarquee] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null)
  const syncRef = useRef<CanvasSync | null>(null)

  const placements = useCanvasStore((s) => s.placements)
  const meta = useCanvasStore((s) => s.meta)
  const selected = useCanvasStore((s) => s.selected)
  const source = useCanvasStore((s) => s.source)

  const dragRef = useRef<{ ids: string[]; pointerId: number; startX: number; startY: number; moved: boolean; lastX?: number; lastY?: number } | null>(null)
  const marqueeRef = useRef<{ pointerId: number; startX: number; startY: number; moved: boolean } | null>(null)
  const panRef = useRef<{ pointerId: number; startX: number; startY: number; moved: boolean; lastDx?: number; lastDy?: number } | null>(null)
  const frameRef = useRef<number | null>(null)
  const pendingPanRef = useRef<{ dx: number; dy: number } | null>(null)
  // 最新图片集合：首屏 init 是异步的，init 之后要用「当前」的图片对账，不能靠闭包里的旧值
  const imagesRef = useRef(images)
  imagesRef.current = images
  // 选中集同理：键盘 effect 只挂一次（[] 依赖），要用「当前」的选中集
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  // 删除回调同理：父级传的是内联箭头（每次渲染换新引用），进依赖数组会让 keydown 监听每帧重挂
  const onRemoveImagesRef = useRef(onRemoveImages)
  onRemoveImagesRef.current = onRemoveImages

  /**
   * ⚠️ 首屏 init 完成前**不得**提交 meta。
   *
   * 挂载时 store 里是默认 meta（`background: 'lines'`），而 init 是异步的；若此时就提交，
   * 会把服务端已存的图案/视口用默认值覆盖掉 —— 实测复现：切到「空白」→ 刷新 → 又回到「线」，
   * 服务端 `canvas_meta` 被回写成 `lines`。位置不受影响（`dirty` 初始为空，不会提交），
   * 只有 meta 会在挂载瞬间被写一次。
   */
  const metaReadyRef = useRef(false)
  /** 刚从快照灌入的 meta：引用相等说明是服务端值的回显，无需回写 */
  const loadedMetaRef = useRef<CanvasMeta | null>(null)
  /** 画布容器尺寸：小地图的视口矩形与跳转居中都要用（ResizeObserver 维护） */
  const [stageSize, setStageSize] = useState({ w: 0, h: 0 })
  /** 小地图开关：瞬态视图偏好，**默认关、不落库**（照抄上游默认关；要跨刷新保留得扩 CanvasMeta 白名单） */
  const [miniMapOpen, setMiniMapOpen] = useState(false)
  /** 右键菜单：锚点是容器内屏幕坐标（与 marquee 同类，属瞬态，不入 store） */
  const [menu, setMenu] = useState<{ x: number; y: number; image: CanvasImage } | null>(null)
  /** 导入进行中 */
  const [importing, setImporting] = useState(false)
  /** 打包 zip 中（批量下载与画布归档共用） */
  const [zipping, setZipping] = useState(false)
  const importRef = useRef<HTMLInputElement | null>(null)

  // 首屏：cloud 为准；cloud 为空或离线才用本地草稿，并在画布上提示「本地草稿」
  useEffect(() => {
    let cancelled = false
    const cloud = createCloudDriver()
    const local = createLocalDriver()
    // 本地草稿作为第三个参数传入：断网时待提交的位置会同时落一份草稿（刷新后仍能看到），
    // 网络恢复或下次加载时云端可用，会把草稿里的位置补交给服务端
    const sync = createCanvasPersistence(cloud, 400, local)
    syncRef.current = sync
    metaReadyRef.current = false
    void (async () => {
      let snapshot = null
      try {
        snapshot = await sync.load(topicId)
      } catch {
        snapshot = null
      }
      if (cancelled) return
      if (snapshot) {
        useCanvasStore.getState().init(topicId, snapshot, 'cloud')
      } else {
        const draft = await local.load(topicId).catch(() => null)
        if (cancelled) return
        useCanvasStore.getState().init(topicId, draft ?? { images: [], meta: useCanvasStore.getState().meta }, draft ? 'local' : 'cloud')
      }
      // ⚠️ init 必须在「按图片集合对账」之前：快照可能整个拿不到（接口失败/首屏竞态），
      // 而 detail 里每张图都自带服务端摆放 —— 不能因为快照为空就让画布整块空白。
      // 这里显式再对一次账，是因为下面的 `[images]` effect 在挂载时跑在 init 之前，会被 init 清掉。
      const after = useCanvasStore.getState()
      after.syncImages(imagesRef.current, viewportOrigin(after.meta.viewport))
      // 快照已就位：此后 meta 的变化才是「用户改的」，可以提交
      loadedMetaRef.current = useCanvasStore.getState().meta
      metaReadyRef.current = true
    })()
    // 网络恢复：把断网期间攒下的位置补交给服务端
    const onOnline = () => {
      void sync.replayPending(topicId)
    }
    window.addEventListener('online', onOnline)
    return () => {
      cancelled = true
      window.removeEventListener('online', onOnline)
      void sync.flush() // 切任务/卸载前把待提交的位置冲掉
      syncRef.current = null
      metaReadyRef.current = false
    }
  }, [topicId])

  // 图片集合变化：清掉已不存在的摆放与选中，并给新出现的图补上摆放
  // （生成产出与转正参考带服务端位置；老行未补位时按空位槽兜底分配）
  useEffect(() => {
    const st = useCanvasStore.getState()
    st.syncImages(images, viewportOrigin(st.meta.viewport))
  }, [images])

  // 位置变更提交：**只在这里防抖**（persistence 层内部 400ms 合并），
  // 不叠加第二层定时器 —— 否则实际落库延迟变成 800ms（「一次窗口只发 1 次 PATCH」也会被两层各算一次）。
  useEffect(() => {
    const dirty = useCanvasStore.getState().dirty
    if (dirty.length === 0) return
    const sync = syncRef.current
    if (!sync) return
    const batch = useCanvasStore.getState().takeDirty()
    if (batch.length === 0) return
    void sync.commitPlacement(topicId, batch).then(async (res) => {
      if (res.rejected.length === 0) {
        useCanvasStore.getState().markClean(batch.map((p) => p.id))
        return
      }
      // 服务端 LWW 拒了更旧的写入（另一标签页改过）：取回服务端值覆盖本地并提示
      const server = await sync.load(topicId).catch(() => null)
      const rejectedSet = new Set(res.rejected)
      useCanvasStore
        .getState()
        .applyServerPlacements((server?.images ?? []).filter((p) => rejectedSet.has(p.id)))
      showToast({ tone: 'warning', message: '另一处已更新，已同步为最新位置。' })
    })
  }, [placements, topicId])

  // 视口/背景变更提交：与位置**共用同一条防抖队列**（窗口结束合成一次 PATCH）。
  // ⚠️ 必须整份 meta 传进去：写成 `commitMeta(topicId, { meta })` 会多包一层 key，
  // 服务端 normalizeCanvasMeta 会把它当未知字段忽略 → 视口永远存不进去。
  // 失败由 persistence 内部兜住（离线时降级本地草稿），故这里无需 catch。
  useEffect(() => {
    const sync = syncRef.current
    if (!sync) return
    if (!metaReadyRef.current) return // 快照未就位：默认 meta 不能回写（见 metaReadyRef 注释）
    if (loadedMetaRef.current === meta) return // 服务端值的回显，无需回写
    sync.commitMeta(topicId, meta)
  }, [meta, topicId])

  // 灯箱关闭后还原焦点（沿用既有 CanvasBoard 的 setTimeout 手法，冒烟 P-1）
  const lightboxRestoreRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (preview) {
      lightboxRestoreRef.current = document.activeElement as HTMLElement | null
      return () => {
        const el = lightboxRestoreRef.current
        setTimeout(() => el?.focus?.(), 0)
      }
    }
  }, [preview])

  // ---------- 平移（空格/Ctrl/中键 + 拖拽）与框选（普通左键拖拽）----------
  //
  // ⚠️ 平移与框选**共用同一个手势**（左键在空白处拖拽），必须裁决 —— 照抄上游
  // `.infinite-canvas-ref/src/components/canvas/infinite-canvas.tsx:114-135`：
  //   `temporaryTool = ctrlKey || isSpacePressed`
  //   `shouldPan = button === 1 || (button === 0 && activeTool === 'pan' && isBackgroundClick)`
  // 即：**中键、或「空格/Ctrl + 左键」= 平移视图；普通左键拖拽 = 框选**。
  // 这样「空格/Ctrl + 左键拖拽平移」与「普通左键拖拽框选」同时成立，
  // 且既有 CanvasBoard 的「左键框选」语义不被改变。
  const [spaceHeld, setSpaceHeld] = useState(false)

  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return
      const t = e.target as HTMLElement | null
      if (t?.tagName === 'INPUT' || t?.tagName === 'TEXTAREA' || t?.isContentEditable) return
      e.preventDefault() // 防止空格滚页面
      setSpaceHeld(true)
    }
    const onUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceHeld(false)
    }
    // 失焦时复位，避免「按住空格切走再回来」卡在平移态
    const onBlur = () => setSpaceHeld(false)
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  const onBackgroundPointerDown = useCallback(
    (e: React.PointerEvent) => {
      const el = containerRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const sx = e.clientX - rect.left
      const sy = e.clientY - rect.top
      const gesture = backgroundGesture({ button: e.button, ctrlKey: e.ctrlKey, spaceHeld })
      if (gesture === 'none') return
      if (gesture === 'pan') {
        panRef.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, moved: false }
      } else {
        // 点击/拖空白：**先清空选中**（拖动后由框选命中重设）—— 沿用既有 CanvasBoard 的语义。
        // ⚠️ 清空必须放在这里而不是 pointerup：早先放在「平移分支」的 pointerup 里，
        // 而普通左键走的是框选分支、panRef 为 null，于是「点空白取消选中」整条失效。
        useCanvasStore.getState().clearSelection()
        marqueeRef.current = { pointerId: e.pointerId, startX: sx, startY: sy, moved: false }
        setMarquee({ x1: sx, y1: sy, x2: sx, y2: sy })
      }
      e.currentTarget.setPointerCapture(e.pointerId)
    },
    [spaceHeld]
  )

  const onBackgroundPointerMove = useCallback((e: React.PointerEvent) => {
    const pan = panRef.current
    if (pan && pan.pointerId === e.pointerId) {
      const dx = e.clientX - pan.startX
      const dy = e.clientY - pan.startY
      if (!pan.moved && Math.hypot(dx, dy) < CLICK_THRESHOLD) return
      pan.moved = true
      // rAF 节流（照抄上游 infinite-canvas.tsx:148-168）
      pendingPanRef.current = { dx, dy }
      if (frameRef.current !== null) return
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null
        const d = pendingPanRef.current
        if (!d) return
        const store = useCanvasStore.getState()
        // 以上一帧的位移增量平移（增量式，避免累积漂移）
        store.panBy(d.dx - (pan.lastDx ?? 0), d.dy - (pan.lastDy ?? 0))
        pan.lastDx = d.dx
        pan.lastDy = d.dy
      })
      return
    }

    const m = marqueeRef.current
    if (!m || m.pointerId !== e.pointerId) return
    const el = containerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top
    if (!m.moved) {
      if (Math.hypot(sx - m.startX, sy - m.startY) < CLICK_THRESHOLD) return
      m.moved = true
    }
    setMarquee({ x1: m.startX, y1: m.startY, x2: sx, y2: sy })
    // 实时命中预览：屏幕选框 → 世界坐标 → 与卡片矩形相交（沿用既有 hitTest 语义：贴边不算）
    const v = useCanvasStore.getState().meta.viewport
    const a = toWorld(Math.min(m.startX, sx), Math.min(m.startY, sy), { x: v.x, y: v.y, scale: v.k })
    const b = toWorld(Math.max(m.startX, sx), Math.max(m.startY, sy), { x: v.x, y: v.y, scale: v.k })
    const cards = Object.entries(useCanvasStore.getState().placements).map(([id, r]) => ({ id, rect: r }))
    useCanvasStore.getState().setSelected(hitTest(cards, { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y }))
  }, [])

  const onBackgroundPointerUp = useCallback((e: React.PointerEvent) => {
    const pan = panRef.current
    if (pan && pan.pointerId === e.pointerId) {
      // 空格/中键平移但没移动 = 在空白处点了一下：同样清空选中
      if (!pan.moved) useCanvasStore.getState().clearSelection()
      panRef.current = null
      pendingPanRef.current = null
    }
    const m = marqueeRef.current
    if (m && m.pointerId === e.pointerId) {
      marqueeRef.current = null
      setMarquee(null)
    }
  }, [])

  // ---------- 拖拽图片（沿用既有 3px 阈值 + 多选整体位移）----------

  const startCardDrag = useCallback(
    (e: React.PointerEvent, img: CanvasImage) => {
      if (e.button !== 0) return
      e.stopPropagation()
      const store = useCanvasStore.getState()
      const ids = store.selected.includes(img.id) ? store.selected : [img.id]
      if (!store.selected.includes(img.id)) store.setSelected(e.shiftKey ? [...store.selected, img.id] : [img.id])
      // ⚠️ key 必须由**本次手势捕获的稳定值**派生（不能含实时选区）：否则拖拽中途选区变化会
      // 变成「不同手势」，一次拖拽落成两步撤销（history.begin 的换 key 分支）。
      store.beginGesture(`drag:${[...ids].sort().join(',')}`)
      dragRef.current = { ids, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, moved: false }
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    },
    []
  )

  const onCardPointerMove = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < CLICK_THRESHOLD) return
    const k = useCanvasStore.getState().meta.viewport.k
    const dx = (e.clientX - drag.startX) / k
    const dy = (e.clientY - drag.startY) / k
    const stepX = drag.moved ? (e.clientX - (drag.lastX ?? drag.startX)) / k : dx
    const stepY = drag.moved ? (e.clientY - (drag.lastY ?? drag.startY)) / k : dy
    drag.moved = true
    drag.lastX = e.clientX
    drag.lastY = e.clientY
    useCanvasStore.getState().moveBy(drag.ids, stepX, stepY)
  }, [])

  const endCardDrag = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    dragRef.current = null
    // 只是点选（没拖动）：作废手势而不是入栈 —— 否则第一次 Ctrl+Z 会先消费这个「空步」
    // （看起来像撤销失灵），50 步上限也会被点选挤光
    const store = useCanvasStore.getState()
    if (drag.moved) store.endGesture()
    else store.cancelGesture()
  }, [])

  /**
   * 右键菜单的关闭兜底：点弹层外任意处、或按 Esc 都关。
   *
   * 为什么不让 HeroUI 弹层自己处理：实测「受控 `isOpen` + 0 尺寸 fixed trigger」这套组合下，
   * 点外部与 Esc 不总会触发 `onOpenChange`（菜单曾关不掉）。这里补一道确定性兜底，
   * 判据用库自己的 `data-slot="dropdown-popover"`，不猜类名；用捕获阶段保证先于画布手势执行。
   */
  useEffect(() => {
    if (!menu) return
    const onDown = (e: PointerEvent) => {
      if ((e.target as Element | null)?.closest('[data-slot="dropdown-popover"]')) return
      setMenu(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null)
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [menu])

  // ---------- 键盘：Esc 清空 / Ctrl+Z / Ctrl+Shift+Z / Ctrl+A 全选 / Delete 删除 ----------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 键位判定与豁免都收在纯函数里（`lib/canvas/shortcuts.ts`，有单测）
      const action = shortcutFor({
        key: e.key,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        shiftKey: e.shiftKey,
        typing: isTypingTarget(e.target),
      })
      if (!action) return
      const store = useCanvasStore.getState()
      if (action === 'escape') {
        // Esc 不 preventDefault（照抄上游）
        setPreview(null)
        setMenu(null)
        store.clearSelection()
        return
      }
      if (action === 'undo') {
        e.preventDefault()
        store.undo()
        return
      }
      if (action === 'redo') {
        e.preventDefault()
        store.redo()
        return
      }
      if (action === 'select-all') {
        e.preventDefault()
        store.setSelected(imagesRef.current.map((i) => i.id))
        return
      }
      // delete：**必须 preventDefault** —— 上游漏了这一句，Backspace 会触发浏览器「后退」
      e.preventDefault()
      const ids = selectedRef.current
      if (ids.length > 0) onRemoveImagesRef.current(imagesRef.current.filter((i) => ids.includes(i.id)))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ---------- 派生 ----------

  const viewport = meta.viewport
  const grid = useMemo(() => gridStyle(meta.background, viewport), [meta.background, viewport])

  // 容器尺寸：小地图的视口矩形与跳转都要按容器算
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const update = () => setStageSize({ w: el.clientWidth, h: el.clientHeight })
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const zoomAtCenter = useCallback((factor: number) => {
    const el = containerRef.current
    if (!el) return
    useCanvasStore.getState().zoomAt(factor, el.clientWidth / 2, el.clientHeight / 2)
  }, [])

  const selectedImages = useMemo(() => images.filter((i) => selected.includes(i.id)), [images, selected])

  /**
   * 摆放矩形列表：`Object.values(placements)` 每次渲染都返回**新数组**，直接当 prop 传会击穿
   * `MiniMap` 里 `useMemo(..., [rects])` 的记忆（每帧重算包围盒 + 比例 + 全部方块）。
   */
  const rects = useMemo(() => Object.values(placements), [placements])

  /** 当前摆放（导出与导入比对共用）：store 里是稀疏表，这里转成 placement 列表 */
  const currentPlacements = useCallback((): CanvasImagePlacement[] => {
    const store = useCanvasStore.getState()
    const now = new Date().toISOString()
    return Object.entries(store.placements).map(([id, r]) => rectToPlacement(id, r, now))
  }, [])

  /**
   * 导出画布归档：`canvas.json` + 每张图的字节 → 一个 zip。
   * **任一张取不到即整单失败**（不产出「只有 canvas.json 的半截归档」）。
   */
  const onExportArchive = useCallback(async () => {
    if (zipping) return
    setZipping(true)
    try {
      const store = useCanvasStore.getState()
      const entries = canvasArchiveEntries({
        topicId,
        meta: store.meta,
        images: currentPlacements(),
        archiveImages: images.map((i) => ({ id: i.id, serial: i.serial, name: i.name, src: i.src, mimeType: i.mimeType })),
        exportedAt: new Date().toISOString(),
      })
      const enc = new TextEncoder()
      const files: Array<{ name: string; data: Uint8Array }> = []
      for (const e of entries) {
        if (e.text !== undefined) {
          files.push({ name: e.name, data: enc.encode(e.text) })
          continue
        }
        const res = await fetch(e.src ?? '')
        if (!res.ok) throw new Error(`导出失败：有图片取不到（HTTP ${res.status}）。`)
        files.push({ name: e.name, data: new Uint8Array(await res.arrayBuffer()) })
      }
      const url = URL.createObjectURL(new Blob([buildZip(files)], { type: 'application/zip' }))
      const a = document.createElement('a')
      a.href = url
      a.download = zipFileName(topicId, images.length)
      document.body.appendChild(a)
      a.click()
      a.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
      showToast({ tone: 'success', message: `已导出画布归档（${images.length} 张图的布局与图片）。` })
    } catch (err) {
      showToast({ tone: 'danger', message: err instanceof Error ? err.message : '导出失败。' })
    } finally {
      setZipping(false)
    }
  }, [topicId, images, zipping, currentPlacements])

  /** 导入画布归档：**只恢复布局**（摆放 + 同任务时的视口/图案），不新建画布图 */
  const onImportFile = useCallback(
    async (file: File | null) => {
      if (importRef.current) importRef.current.value = '' // 允许重复导入同一文件
      if (!file) return
      setImporting(true)
      try {
        const parsed = parseCanvasArchive(readZip(new Uint8Array(await file.arrayBuffer())))
        const store = useCanvasStore.getState()
        // ⚠️ 时间戳重盖为当前时间：沿用归档里的旧戳会被服务端图片级 LWW 整批拒掉
        const { applied, skipped } = mergeImportedPlacements(currentPlacements(), parsed.images, new Date().toISOString())
        if (applied.length > 0) {
          store.applyPlacements(applied)
          // 视口/图案只在**确实恢复了图片**且归档属于当前任务时才动：
          // 否则「导入失败」也会把视口与图案改掉，而 meta 是会被提交落库的
          if (parsed.topicId === topicId) {
            store.setViewport(parsed.meta.viewport)
            store.setBackground(parsed.meta.background)
          }
        }
        if (applied.length === 0) showToast({ tone: 'danger', message: '没有可恢复的图片（归档里的图不在当前任务）。' })
        else if (skipped.length > 0) showToast({ tone: 'warning', message: `已恢复 ${applied.length} 张，${skipped.length} 张因图片不存在被跳过。` })
        // 位置落库走共用防抖队列（约 400ms 后发一次 PATCH），所以这里只说「已恢复」，
        // 不承诺已写进服务端；被 LWW 拒掉的情况由提交回调单独提示
        else showToast({ tone: 'success', message: `已恢复 ${applied.length} 张图的位置。` })
      } catch (err) {
        showToast({ tone: 'danger', message: err instanceof Error ? err.message : '导入失败。' })
      } finally {
        setImporting(false)
      }
    },
    [topicId, currentPlacements]
  )

  const onArchiveAction = useCallback(
    async (key: string) => {
      if (key === 'export') await onExportArchive()
      else if (key === 'import') importRef.current?.click()
    },
    [onExportArchive]
  )

  /**
   * 单图下载：与批量下载同源手法（造一个 `<a download>` 点一下），不另引依赖。
   *
   * 文件名必须走 `zipEntryName` —— 生成的图片 `name` 只有「图片 N」没有后缀，
   * 直接用 `img.name` 会下到一个无后缀文件、双击打不开（批量下载早就补了后缀，单图漏了）。
   */
  const downloadImage = useCallback((img: CanvasImage) => {
    const a = document.createElement('a')
    a.href = img.src
    a.download = zipEntryName(img)
    document.body.appendChild(a)
    a.click()
    a.remove()
  }, [])

  /** 图片上右键：先只选它（与左键点选语义一致），再把菜单钉在指针处（用视口坐标，见 CanvasContextMenu 注释） */
  const onCardContextMenu = useCallback((e: React.MouseEvent, img: CanvasImage) => {
    e.preventDefault()
    e.stopPropagation()
    if (!useCanvasStore.getState().selected.includes(img.id)) useCanvasStore.getState().setSelected([img.id])
    setMenu({ x: e.clientX, y: e.clientY, image: img })
  }, [])

  /** 空白处右键：关菜单，且**不 preventDefault**（保留浏览器原生菜单，照抄上游语义） */
  const onStageContextMenu = useCallback((e: React.MouseEvent) => {
    if ((e.target as Element | null)?.closest('.canvas-img-card')) return
    setMenu(null)
  }, [])

  const onMenuAction = useCallback(
    (action: ContextMenuAction) => {
      const target = menu?.image
      setMenu(null)
      if (!target) return
      if (action === 'preview') setPreview(target)
      else if (action === 'reference') onAddReferences([target])
      else if (action === 'download') downloadImage(target)
      else onRemoveImages([target]) // 删除：走 Workspace 的二次确认
    },
    [menu, onAddReferences, onRemoveImages, downloadImage]
  )

  /**
   * 批量下载：把所选图片的字节取回，打包成一个 zip 再触发一次下载。
   *
   * 为什么打包而不是逐个下载 N 个文件：浏览器会对「短时间内多个下载」弹拦截提示，
   * 12 张就会变成 12 个文件 + 一次拦截；合成一个 zip 只下载一次。
   * zip 由 `lib/zip.ts` 手写（仅 store 不压缩，零新依赖 —— 依赖白名单只允许 zustand）。
   */
  const downloadSelectedAsZip = useCallback(async () => {
    if (selectedImages.length === 0 || zipping) return
    setZipping(true)
    try {
      const entries = zipEntriesFor(selectedImages)
      const files = await Promise.all(
        entries.map(async (e) => {
          const res = await fetch(e.src)
          if (!res.ok) throw new Error(`取图失败 ${res.status}`)
          return { name: e.name, data: new Uint8Array(await res.arrayBuffer()) }
        })
      )
      const url = URL.createObjectURL(new Blob([buildZip(files)], { type: 'application/zip' }))
      const a = document.createElement('a')
      a.href = url
      a.download = zipFileName(topicId, files.length)
      a.click()
      // 延后回收：同步 revoke 可能在下载开始读取前就把 blob URL 撤销（沿用 admin/cdks 页的做法）
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      showToast({ tone: 'success', message: `已打包 ${files.length} 张，开始下载` })
    } catch {
      showToast({ tone: 'danger', message: '打包下载失败，请重试。' })
    } finally {
      setZipping(false)
    }
  }, [selectedImages, topicId, zipping])

  return (
    <div className="relative min-h-full select-none" style={{ background: 'var(--canvas-background)' }}>
      <div
        ref={containerRef}
        className="canvas-stage relative h-full w-full overflow-hidden touch-none"
        onContextMenu={onStageContextMenu}
        style={{ minHeight: 'calc(100dvh - 64px)', cursor: spaceHeld ? 'grab' : undefined }}
        onPointerDown={onBackgroundPointerDown}
        onPointerMove={onBackgroundPointerMove}
        onPointerUp={onBackgroundPointerUp}
        onPointerCancel={onBackgroundPointerUp}
        onWheel={(e) => {
          // 弹层/控件内不缩放（照抄上游 infinite-canvas.tsx:89 的豁免思路；
          // 上游列的是 .ant-* 选择器，Motif 用 HeroUI，故改为这两个语义选择器）
          const target = e.target instanceof Element ? e.target : null
          if (target?.closest('[data-canvas-no-zoom],[role="dialog"]')) return
          // ⚠️ 只看 e.target 不够：Chrome 对一次滚轮手势做「latching」，同一手势的后续事件会
          // 重定向到滚动链上的容器（实测第一发 target 是小地图、后两发变成画布容器），
          // 于是「在小地图上滚轮」仍会缩放。再按指针位置判一次，与 target 无关。
          const under = typeof document !== 'undefined' ? document.elementFromPoint(e.clientX, e.clientY) : null
          if (under?.closest('[data-canvas-no-zoom],[role="dialog"]')) return
          e.preventDefault()
          const el = containerRef.current
          if (!el) return
          const rect = el.getBoundingClientRect()
          useCanvasStore.getState().zoomAt(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, e.clientX - rect.left, e.clientY - rect.top)
        }}
      >
        {/* 背景图案：照抄上游 CanvasGrid（图案联动视口），底色取中性 --canvas-background */}
        {grid && <div className="pointer-events-none absolute inset-0" style={grid} data-testid="canvas-grid" />}

        {/* 世界层 */}
        <div
          className="absolute left-0 top-0"
          style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.k})`, transformOrigin: '0 0' }}
        >
          {images.map((img) => {
            const p = placements[img.id]
            if (!p) return null
            const isSel = selected.includes(img.id)
            return (
              <figure
                key={img.id}
                className={`canvas-img-card${isSel ? ' canvas-img-card-selected' : ''}`}
                style={{ left: p.x, top: p.y, width: p.w, margin: 0, cursor: 'grab' }}
                onPointerDown={(e) => startCardDrag(e, img)}
                onPointerMove={onCardPointerMove}
                onPointerUp={endCardDrag}
                onDoubleClick={() => setPreview(img)}
                onContextMenu={(e) => onCardContextMenu(e, img)}
                aria-label={`#${String(img.serial).padStart(3, '0')} ${img.name}`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={img.src} alt={img.name} draggable={false} loading="lazy" style={{ width: '100%', display: 'block' }} />
                <figcaption className="canvas-img-label">
                  #{String(img.serial).padStart(3, '0')} {img.name}
                  {img.origin === 'uploaded' ? ' · 参考图' : ''}
                </figcaption>
              </figure>
            )
          })}
        </div>

        {/* 框选选框（屏幕坐标覆盖层） */}
        {marquee && marqueeRef.current?.moved && (
          <div
            className="canvas-marquee"
            style={{
              left: Math.min(marquee.x1, marquee.x2),
              top: Math.min(marquee.y1, marquee.y2),
              width: Math.abs(marquee.x2 - marquee.x1),
              height: Math.abs(marquee.y2 - marquee.y1),
            }}
          />
        )}

        {/* 选中浮动工具栏（沿用既有 markup 与文案） */}
        {selectedImages.length === 1 && (
          <Toolbar
            aria-label="图片操作"
            className="canvas-toolbar"
            style={toolbarAnchor([placements[selectedImages[0].id]], viewport) ?? undefined}
            data-canvas-no-zoom
            onPointerDown={(e) => e.stopPropagation()}
          >
            <Button isIconOnly size="sm" variant="secondary" aria-label="放大预览" onPress={() => setPreview(selectedImages[0])}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M15 3h6v6" /><path d="m21 3-7 7" /><path d="m3 21 7-7" /><path d="M9 21H3v-6" />
              </svg>
            </Button>
            <Button size="sm" variant="secondary" aria-label="加入参考图，并把编号写进提示词" onPress={() => onAddReferences([selectedImages[0]])}>
              @ 引用
            </Button>
            <Button
              isIconOnly
              size="sm"
              variant="secondary"
              aria-label="下载"
              render={anchorRender({ href: selectedImages[0].src, download: selectedImages[0].name })}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M12 15V3" /><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5" />
              </svg>
            </Button>
            <span className="canvas-tool-divider" />
            <Button isIconOnly size="sm" variant="danger" aria-label="删除所选图片" onPress={() => onRemoveImages([selectedImages[0]])}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M10 11v6" /><path d="M14 11v6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            </Button>
          </Toolbar>
        )}

        {/* 多选批量工具栏 */}
        {selectedImages.length > 1 && (
          <Toolbar
            aria-label="批量操作"
            className="canvas-toolbar"
            style={toolbarAnchor(selectedImages.map((i) => placements[i.id]), viewport) ?? undefined}
            data-canvas-no-zoom
            onPointerDown={(e) => e.stopPropagation()}
          >
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>已选 {selectedImages.length} 张</span>
            <span className="canvas-tool-divider" />
            <Button
              size="sm"
              variant="secondary"
              aria-label="把所选图片全部加入参考图"
              onPress={() => onAddReferences(selectedImages)}
            >
              @ 引用
            </Button>
            <Button
              isIconOnly
              size="sm"
              variant="secondary"
              aria-label="批量下载（打包为 zip）"
              isDisabled={zipping}
              onPress={downloadSelectedAsZip}
            >
              {zipping ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                  <path d="M12 3a9 9 0 1 0 9 9" />
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M12 15V3" /><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5" />
                </svg>
              )}
            </Button>
            <span className="canvas-tool-divider" />
            <Button isIconOnly size="sm" variant="danger" aria-label="删除所选图片" onPress={() => onRemoveImages(selectedImages)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M10 11v6" /><path d="M14 11v6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            </Button>
          </Toolbar>
        )}
      </div>

      {/* 顶部信息与操作 —— 沿用既有 CanvasBoard 的 pill + 整理布局入口 */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-3">
        <div className="canvas-pill pointer-events-auto flex items-center gap-2">
          <span className="canvas-pill-count">{images.length} 张图片</span>
          {source === 'local' && (
            <>
              <span className="canvas-pill-divider" />
              <span className="canvas-pill-count" data-testid="canvas-local-draft">本地草稿</span>
            </>
          )}
          {selected.length > 0 && (
            <>
              <span className="canvas-pill-divider" />
              <span className="canvas-pill-count">已选 {selected.length}</span>
              <Button size="sm" variant="secondary" onPress={() => useCanvasStore.getState().clearSelection()}>清空选择</Button>
            </>
          )}
        </div>
        {/* 右侧两个入口必须包成**同一个 flex 项**：容器是 `justify-between`，三个直接子项会让
            中间那个（「整理布局」）被推到画布正中，与紧邻的归档菜单拉开半屏 */}
        <div className="pointer-events-none flex items-center gap-2">
          {/* 整理布局：沿用既有入口。语义从「重置到网格」升级为「把所有图重排进空位槽并落库」 */}
          <Button
            variant="secondary"
            className="pointer-events-auto"
            data-canvas-no-zoom
            onPress={() => {
              const all = images.map((i) => i.id)
              useCanvasStore.getState().beginGesture('arrange')
              const slots = allocateSlots(
                [],
                images.map((i) => displaySize(i.width, i.height)),
                viewportOrigin(viewport)
              )
              useCanvasStore.getState().applyPlacements(slots.map((s, i) => rectToPlacement(all[i], s, new Date().toISOString())))
              useCanvasStore.getState().endGesture()
            }}
          >
            整理布局
          </Button>
          {/* 画布归档（导出/导入）。⚠️ 外层是 pointer-events-none，新控件必须显式 pointer-events-auto
              + data-canvas-no-zoom（既有「整理布局」就是这么写的，缺前者点不动）。
              ⚠️ 触发件用 Dropdown 的**直接子元素**（官方 default demo 的写法）：`Dropdown.Trigger`
              内部会再渲染一个 HeroUI Button，写成 `<Trigger><Button/></Trigger>` 会得到 `<button>` 套
              `<button>`（React 19 报 validateDOMNesting，且 isDisabled 落在内层、靠冒泡被吃掉才偶然生效） */}
          <Dropdown>
            <Button variant="secondary" className="pointer-events-auto" data-canvas-no-zoom isDisabled={zipping || importing}>
              {zipping ? '打包中…' : importing ? '导入中…' : '画布归档'}
            </Button>
            <Dropdown.Popover placement="bottom end">
              <Dropdown.Menu onAction={(key) => void onArchiveAction(String(key))}>
                <Dropdown.Item id="export" textValue="导出画布（zip）">
                  <Label>导出画布（zip）</Label>
                </Dropdown.Item>
                <Dropdown.Item id="import" textValue="导入画布（zip）">
                  <Label>导入画布（zip）</Label>
                </Dropdown.Item>
                {/* 说明用禁用项承载：菜单里只允许 menuitem/group/separator，裸 Label 不是合法菜单内容 */}
                <Dropdown.Item id="import-hint" textValue="导入只恢复布局与视口，不会把图片导进来" isDisabled>
                  <Label>导入只恢复布局与视口，不会把图片导进来</Label>
                </Dropdown.Item>
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
          <input ref={importRef} type="file" accept=".zip,application/zip" hidden onChange={(e) => void onImportFile(e.target.files?.[0] ?? null)} />
        </div>
      </div>

      {/* 小地图：默认关，开关在右下视图簇。组件自身是 `hidden lg:block`（240px 宽在手机上占掉近半屏），
          故**开关按钮也必须只在 lg 以上出现** —— 否则窄屏点得动却什么都不会出现 */}
      {miniMapOpen && stageSize.w > 0 && (
        <MiniMap
          rects={rects}
          viewport={viewport}
          size={stageSize}
          onJump={(v) => useCanvasStore.getState().setViewport(v)}
        />
      )}

      {/* 图片右键菜单：锚点用容器内坐标（Dropdown 自己负责贴边翻转） */}
      <CanvasContextMenu
        anchor={menu ? { x: menu.x, y: menu.y } : null}
        onClose={() => setMenu(null)}
        onAction={onMenuAction}
      />

      {/* 右下视图控件：缩放 + 小地图开关 + 背景图案三态（都是「视图」而非「内容」，故同簇）。
          窄屏这一簇会超过画布宽度，而画布是 overflow-hidden（会被裁掉而不是出滚动条）→
          必须允许换行并限制最大宽度，否则左侧按钮在手机上点不到 */}
      <Toolbar className="canvas-zoombar max-w-[calc(100%-24px)] flex-wrap justify-end" aria-label="画布视图" data-canvas-no-zoom>
        <ButtonGroup>
          <Button isIconOnly size="sm" variant="secondary" aria-label="缩小" onPress={() => zoomAtCenter(1 / ZOOM_STEP)}>−</Button>
          <Button size="sm" variant="secondary" aria-label="重置为 100%" onPress={() => useCanvasStore.getState().setViewport({ ...viewport, k: 1 })}>
            {Math.round(viewport.k * 100)}%
          </Button>
          <Button isIconOnly size="sm" variant="secondary" aria-label="放大" onPress={() => zoomAtCenter(ZOOM_STEP)}>＋</Button>
        </ButtonGroup>
        <span className="canvas-tool-divider" />
        <Button
          size="sm"
          variant="ghost"
          onPress={() => {
            const el = containerRef.current
            if (!el) return
            const rs = rects
            const b = boundsOf(rs)
            if (!b) return
            useCanvasStore.getState().setViewport(fitView(b, el.clientWidth, el.clientHeight))
          }}
        >
          适应
        </Button>
        <span className="canvas-tool-divider" />
        <Button
          size="sm"
          variant={miniMapOpen ? 'primary' : 'ghost'}
          aria-label="小地图"
          aria-pressed={miniMapOpen}
          /* hidden lg:inline-flex：与 MiniMap 自身的 `hidden lg:block` 对齐（见上方注释） */
          className="hidden lg:inline-flex"
          onPress={() => setMiniMapOpen((v) => !v)}
        >
          小地图
        </Button>
        <span className="canvas-tool-divider" />
        <ToggleButtonGroup
          aria-label="网格样式"
          selectionMode="single"
          selectedKeys={new Set([meta.background])}
          onSelectionChange={(keys) => {
            const next = BACKGROUND_OPTIONS.find((o) => o.key === [...keys][0])
            if (next) useCanvasStore.getState().setBackground(next.key)
          }}
        >
          {BACKGROUND_OPTIONS.map((o) => (
            <ToggleButton key={o.key} id={o.key} size="sm">
              {o.label}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      </Toolbar>

      {/* 屏幕阅读器图片清单 */}
      <ul className="sr-only">
        {images.map((img) => (
          <li key={img.id}>#{String(img.serial).padStart(3, '0')} {img.name}</li>
        ))}
      </ul>

      {/* 灯箱预览（HeroUI Modal 容器；点背景/✕/Esc 关闭）—— 与既有实现逐字一致 */}
      {preview && (
        <Modal.Backdrop
          isOpen
          onOpenChange={(open) => {
            if (!open) setPreview(null)
          }}
        >
          <Modal.Container>
            <Modal.Dialog aria-label="图片预览" className="max-w-[min(920px,92vw)]">
              <Modal.CloseTrigger aria-label="关闭预览">✕</Modal.CloseTrigger>
              <Modal.Body className="p-0">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={preview.src} alt={preview.name} onClick={(e) => e.stopPropagation()} style={{ display: 'block', maxWidth: '100%', maxHeight: '72vh' }} />
              </Modal.Body>
              <Modal.Footer className="justify-center">
                <p className="canvas-lightbox-caption">
                  #{String(preview.serial).padStart(3, '0')} {preview.name}
                  {/* 升级前转正的历史行 width/height 仍是 0：不显示「0×0」 */}
                  {preview.width > 0 && preview.height > 0 && ` · ${preview.width}×${preview.height}`}
                </p>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      )}
    </div>
  )
}

export { CanvasStage }
