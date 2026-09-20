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
import { Button, ButtonGroup, Modal, Toolbar } from '@heroui/react'
import type { CanvasImage } from '@motif/core'
import { anchorRender } from '@/components/ui/anchor-button'
import { boundsOf, hitTest, toWorld } from '@/lib/canvas/geometry'
import { backgroundGesture } from '@/lib/canvas/gesture'
import { gridStyle } from '@/lib/canvas/grid'
import { zipEntriesFor, zipFileName } from '@/lib/canvas/download'
import { buildZip } from '@/lib/zip'
import { allocateSlots, displaySize, rectToPlacement, viewportOrigin } from '@/lib/canvas/placement'
import { createCloudDriver, createLocalDriver, createCanvasPersistence, type CanvasSync } from '@/stores/canvas/persistence'
import { useCanvasStore } from '@/stores/canvas/useCanvasStore'
import { ZOOM_STEP, fitView, toolbarAnchor } from '@/lib/canvas/viewport'
import { showToast } from '@/components/ui/toast'

const CLICK_THRESHOLD = 3

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

  // 首屏：cloud 为准；cloud 为空或离线才用本地草稿，并在画布上提示「本地草稿」
  useEffect(() => {
    let cancelled = false
    const cloud = createCloudDriver()
    const local = createLocalDriver()
    // 本地草稿作为第三个参数传入：断网时待提交的位置会同时落一份草稿（刷新后仍能看到），
    // 网络恢复或下次加载时云端可用，会把草稿里的位置补交给服务端
    const sync = createCanvasPersistence(cloud, 400, local)
    syncRef.current = sync
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
  // 这样 L4-2-G1-A1（空白处拖拽平移）与 L4-2-G1-A2（框选多选）同时成立，
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

  // ---------- 键盘：Esc 清空 / Ctrl+Z / Ctrl+Shift+Z ----------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable
      if (e.key === 'Escape') {
        setPreview(null)
        useCanvasStore.getState().clearSelection()
        return
      }
      if (typing) return // 输入框内不拦截（照抄上游 lib/keyboard-event.ts 的豁免思路）
      if (!(e.ctrlKey || e.metaKey)) return
      if (e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) useCanvasStore.getState().redo()
        else useCanvasStore.getState().undo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ---------- 派生 ----------

  const viewport = meta.viewport
  const grid = useMemo(() => gridStyle(meta.background, viewport), [meta.background, viewport])

  const zoomAtCenter = useCallback((factor: number) => {
    const el = containerRef.current
    if (!el) return
    useCanvasStore.getState().zoomAt(factor, el.clientWidth / 2, el.clientHeight / 2)
  }, [])

  const selectedImages = useMemo(() => images.filter((i) => selected.includes(i.id)), [images, selected])

  /**
   * 批量下载：把所选图片的字节取回，打包成一个 zip 再触发一次下载。
   *
   * 为什么打包而不是逐个下载 N 个文件：浏览器会对「短时间内多个下载」弹拦截提示，
   * 12 张就会变成 12 个文件 + 一次拦截；合成一个 zip 只下载一次。
   * zip 由 `lib/zip.ts` 手写（仅 store 不压缩，零新依赖 —— 依赖白名单只允许 zustand）。
   */
  const [zipping, setZipping] = useState(false)
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
      </div>

      {/* 右下缩放控件 */}
      <Toolbar className="canvas-zoombar" aria-label="缩放" data-canvas-no-zoom>
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
            const rs = Object.values(placements)
            const b = boundsOf(rs)
            if (!b) return
            useCanvasStore.getState().setViewport(fitView(b, el.clientWidth, el.clientHeight))
          }}
        >
          适应
        </Button>
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
                  #{String(preview.serial).padStart(3, '0')} {preview.name} · {preview.width}×{preview.height}
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
