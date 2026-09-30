/**
 * 画布视口容器：世界层变换（平移/缩放）+ 背景图案 + 框选/拖拽/撤销。
 *
 * 参考 `.infinite-canvas-ref/src/components/canvas/infinite-canvas.tsx` 的整体结构
 * （外层容器接管 wheel/pointer、内层世界层用 transform 承载节点、独立一层画背景网格）。
 * 适配改动：
 *  - 只渲染图片节点；连线、小地图、右键菜单、快捷键表、复制粘贴不在本层
 *  - 弹层豁免选择器由上游的 `.ant-*` 改为 `[data-canvas-no-zoom]` / `[role="dialog"]`（Motif 用 HeroUI）
 *  - 底色取 `var(--canvas-background)`（中性，不抄上游的暖底）
 *
 * ⚠️ 控件与文案经历过两次裁决，**后一次覆盖前一次**（留痕，勿按前一次回改）：
 * - 2026-09-20 的裁决：保留既有 CanvasBoard 的**全部**控件与文案 ——
 *   顶部 pill（张数 / 已选 / 清空选择）、整理布局、单选工具栏（放大预览 / @ 引用 / 再生成 / 下载 / 删除）、
 *   多选工具栏（已选 N 张 / 批量删除）、缩放条（−/百分比/＋/适应）、sr-only 清单、灯箱。
 *   语义变化：**整理布局**从「重置到网格」升级为「重排进空位槽并落库」。
 * - 2026-09-21 的裁决：全站图标化。上一条里「保留文案」这一条对**次要 / 破坏性 / 视图类**
 *   控件不再适用 —— 它们改为「图标 + Tooltip」（Tooltip 文案同时作 aria-label，见 ui/icon-button.tsx）；
 *   而**承载数字或状态**的文案（「N 张图片」「已选 N 张」「100%」）、灯箱说明、引导提示一律保留文字。
 *   ✅ 本文件**没有例外**：原先认为「Tooltip 与 Dropdown 触发件结构上不能共存」，2026-09-21 运行时实证
 *   推翻了该判断（DropdownRoot 是 RAC MenuTrigger，trigger props 经 PressResponderContext 下发、children
 *   原样渲染，React context 穿过 Tooltip）—— 「画布归档」已是普通的 IconButton。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Button,
  ButtonGroup,
  Dropdown,
  Kbd,
  Label,
  Modal,
  ToggleButton,
  ToggleButtonGroup,
  Toolbar,
  Tooltip,
} from '@heroui/react'
import { InlineText } from '@/components/ui/typography'
import {
  Archive,
  ArrowRotateRight,
  Bars,
  CircleXmark,
  Crop,
  Dots9,
  Ellipsis,
  Frame,
  Hierarchy,
  LayoutCellsLarge,
  MapPin,
  Minus,
  Plus,
  SquareDashed,
} from '@gravity-ui/icons'
import { IconButton } from '@/components/ui/icon-button'
import type { CanvasBackgroundMode, CanvasImage, CanvasImagePlacement, CanvasMeta, Message } from '@motif/core'
import { boundsOf, hitTest, toWorld } from '@/lib/canvas/geometry'
import { backgroundGesture } from '@/lib/canvas/gesture'
import { zipEntriesFor, zipEntryName, zipFileName } from '@/lib/canvas/download'
import { buildZip, readZip } from '@/lib/zip'
import { errorMessage } from '@/lib/error-message'
import { canvasArchiveEntries, mergeImportedPlacements, parseCanvasArchive } from '@/lib/canvas/archive'
import {
  allocateSlots,
  centerRectsInViewport,
  displaySize,
  rectToPlacement,
  viewportOrigin,
} from '@/lib/canvas/placement'
import { deriveLineage, isSameLayout, layoutLineageTree } from '@/lib/canvas/lineage'
import {
  createCloudDriver,
  createLocalDriver,
  createCanvasPersistence,
  type CanvasSync,
} from '@/stores/canvas/persistence'
import { MiniMap } from './MiniMap'
import { CanvasWorld } from './CanvasWorld'
import { CanvasZoomReadout } from './CanvasZoomReadout'
import { SelectionToolbar } from './SelectionToolbar'
import { CanvasContextMenu, type ContextMenuAction } from './CanvasContextMenu'
import { useCanvasStore } from '@/stores/canvas/useCanvasStore'
import {
  ZOOM_STEP,
  baseScale,
  fitView,
  zoomStepsToFactor,
  type ToolbarPanelRect,
  type Viewport,
} from '@/lib/canvas/viewport'
import { isTypingTarget, shortcutFor } from '@/lib/canvas/shortcuts'
import { pinchBegin, pinchUpdate, type PinchState } from '@/lib/canvas/pinch'
import { MINIMAP_W } from '@/lib/canvas/minimap'
import type { PendingSkeleton } from '@/lib/canvas/skeleton'
import { showToast } from '@/components/ui/toast'

const CLICK_THRESHOLD = 3

/**
 * 参与「工具栏可用区间」计算的浮动元素：两侧展开的面板 + 两侧收起态的浮动条。
 *
 * 用 `querySelector` 读而不是把宽度传下来：宽度是 CSS 决定的（左 280 / 右 372，窄屏还是抽屉，
 * 收起条按内容自适应），硬编码一份就会在改样式时静默失配；而这里要的正是「它此刻实际占了多宽」。
 * ⚠️ 前提是**页面里只有一份工作台**（这些类名是全局的，`document` 级查询会命中别的实例）。
 */
const FLOAT_PANEL_SELECTORS: ReadonlyArray<readonly ['left' | 'right', string]> = [
  ['left', '.ws-float-left'],
  ['left', '.ws-collapsed-left'],
  ['right', '.ws-float-right'],
  ['right', '.ws-collapsed-right'],
]

/** 量出容器宽与各浮动元素的**容器内矩形**（交给 `@/lib/canvas/viewport` 的纯函数算可用区间） */
function measureBandInput(el: HTMLElement): { width: number; panels: ToolbarPanelRect[] } {
  const host = el.getBoundingClientRect()
  const panels: ToolbarPanelRect[] = []
  for (const [side, sel] of FLOAT_PANEL_SELECTORS) {
    const panel = document.querySelector(sel)
    if (!panel) continue
    const r = panel.getBoundingClientRect()
    panels.push({ side, left: r.left - host.left, top: r.top - host.top, width: r.width, height: r.height })
  }
  return { width: host.width, panels }
}

/**
 * 背景图案三态。取值域与默认值见 `@motif/core` 的 `CanvasBackgroundMode` / `DEFAULT_CANVAS_META`。
 * 文案照抄上游 `.infinite-canvas-ref/src/components/canvas/canvas-toolbar.tsx` 的 zh-CN 词条
 * （点 / 线 / 空白），分组标题「网格样式」同源；上游用 AntD Segmented，这里按 HeroUI 重写。
 *
 * 图标化（2026-09-21）：三段各只有 1 个汉字，但它们处在**空间最紧的**画布缩放条里，
 * 且语义有直接图形（点阵 / 横线 / 空框）→ 换成图标 + Tooltip，label 仍保留原词条。
 */
const BACKGROUND_OPTIONS: Array<{ key: CanvasBackgroundMode; label: string; icon: React.ReactNode }> = [
  { key: 'dots', label: '点', icon: <Dots9 /> },
  { key: 'lines', label: '线', icon: <Bars /> },
  { key: 'blank', label: '空白', icon: <SquareDashed /> },
]

/**
 * 工具栏「放不下就收进 …」的档位阶梯（2026-09-21 用户裁决：窄屏**不换行**，改成「…」下拉）。
 *
 * 每档是「累计被收走的单元」，从 L0（全显示）往下递增，**收走的顺序 = 重要度从低到高**：
 * 状态读数（信息，可以让位）→ 画布背景（纯外观）→ 小地图（默认就关）→ 画布归档（低频）
 * → 整理布局（低频且可撤销）→ 视图开关（适应 / 溯源）→ 框选。
 * 留在最后的：缩放读数与「…」菜单本身 —— 它们是读数/出口，任何宽度下都不能没有。
 *
 * ⚠️ **「框选」最后才收，且支持的四档（393/375/360/320）都不许走到那一档** ——
 * 触屏上没有 Shift，框选一旦进了「…」就等于仍不可达，这一档等于「明确放弃」。
 * 宽度预算是实测的（44px 触摸目标）：收走读数区与视图开关后内容宽 269，320 视口可用 294。
 *
 * ⚠️ 为什么不用视口断点写死：工具栏是**居中**的，可用宽度 = 画布宽 − 24，
 * 而工具栏自身宽度又随内容变；断点写死会在某些宽度下「明明放得下却被收」。
 * 这里按**实际测出来的 scrollWidth** 逐档收敛（见下面那对 effect）。
 */
const TOOLBAR_LEVELS: readonly (readonly string[])[] = [
  [],
  ['status'],
  ['status', 'background'],
  ['status', 'background', 'minimap'],
  ['status', 'background', 'minimap', 'archive'],
  ['status', 'background', 'minimap', 'archive', 'arrange'],
  ['status', 'background', 'minimap', 'archive', 'arrange', 'view'],
  ['status', 'background', 'minimap', 'archive', 'arrange', 'view', 'marquee'],
]

/** 工具栏可用宽度「定档」前的静默期（ms）。见 `rawToolbarAvail` 处的注释。 */
const TOOLBAR_SETTLE_MS = 120

interface Props {
  topicId: string
  images: CanvasImage[]
  /** 本任务的全部生成轮次：溯源推导（id + referenceIds）与「再生成」取原始提示词（id + prompt）都要用 */
  messages: Message[]
  /**
   * 待产出骨架槽（#88）：由父级从「消息的槽位计划 + 已落库张数」推出。
   * 传进来的理由有二：① 父级要用它决定「一张图都没有时也渲染画布」（否则首轮骨架无处显示）；
   * ② 只算一次，避免父子各算一份漂移。骨架**不是图片**，不进下面的图片渲染与统计。
   */
  skeletons: PendingSkeleton[]
  onRemoveImages: (imgs: CanvasImage[]) => void
  /** 加入参考图（单张与批量共用；批量时一次写多句 #编号） */
  onAddReferences: (imgs: CanvasImage[]) => void
  /** 「以它为参考再生成」：把该图所属轮次的原始提示词与这张图填回表单（替换画布引用） */
  onRegenerate: (img: CanvasImage) => void
}

function CanvasStage({ topicId, images, messages, skeletons, onRemoveImages, onAddReferences, onRegenerate }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [preview, setPreview] = useState<CanvasImage | null>(null)
  // 框选选框：`moved` 与坐标同放 state —— 渲染期不能读 marqueeRef.current
  // （react-hooks/refs：Cannot access refs during render）。ref 那份 `moved` 仍由手势处理函数
  // 读写（判定是否越过 3px 阈值），这里只是把同一事实镜像进 state 供渲染用。
  const [marquee, setMarquee] = useState<{ x1: number; y1: number; x2: number; y2: number; moved: boolean } | null>(
    null,
  )
  const syncRef = useRef<CanvasSync | null>(null)

  const placements = useCanvasStore((s) => s.placements)
  // ⚠️ 只订阅**具体字段**，不要订阅整份 `meta`：平移每帧都改 meta，订阅整份会让外层
  // （缩放条、顶部 pill、选中工具栏、背景选择器）每帧重渲染。三个窄订阅的取舍：
  //  - `background` 是字符串，极少变；
  //  - 缩放读数（`viewport.k`）的订阅已下沉到 `CanvasZoomReadout`：`k` 在**缩放**时变，
  //    留在这里会让外层重渲染 ⇒ 重建 20 张卡片的 `children` ⇒ 卡片逐帧 reconcile。
  const background = useCanvasStore((s) => s.meta.background)
  const selected = useCanvasStore((s) => s.selected)
  const source = useCanvasStore((s) => s.source)

  const dragRef = useRef<{
    ids: string[]
    pointerId: number
    startX: number
    startY: number
    moved: boolean
    lastX?: number
    lastY?: number
  } | null>(null)
  const marqueeRef = useRef<{ pointerId: number; startX: number; startY: number; moved: boolean } | null>(null)
  const panRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    moved: boolean
    lastDx?: number
    lastDy?: number
  } | null>(null)
  const frameRef = useRef<number | null>(null)
  const pendingPanRef = useRef<{ dx: number; dy: number } | null>(null)
  // 滚轮缩放与卡片拖拽各自的 rAF 槽：与平移的 frameRef 分开，避免一次手势把另一边的待处理值吃掉
  const zoomFrameRef = useRef<number | null>(null)
  const pendingZoomRef = useRef<{ steps: number; anchorX: number; anchorY: number } | null>(null)
  const dragFrameRef = useRef<number | null>(null)
  const pendingDragRef = useRef<{ dx: number; dy: number } | null>(null)

  // 当前按下的**触摸**指针（容器内坐标）。只记 pointerType === 'touch'，鼠标/触控笔不进来。
  const touchPointsRef = useRef<Map<number, { x: number; y: number }>>(new Map())
  const pinchRef = useRef<PinchState | null>(null)
  // ⚠️ pinch 用**独立的** rAF 帧槽，不复用 frameRef / zoomFrameRef / dragFrameRef ——
  //    上面那行注释已写明「避免一次手势把另一边的待处理值吃掉」。
  //    与平移不同，这里存的是**绝对视口**（pinchUpdate 从手势起始视口重算）而不是增量。
  const pinchFrameRef = useRef<number | null>(null)
  const pendingPinchRef = useRef<Viewport | null>(null)

  // 卸载时取消在途的 rAF：否则回调会在组件卸载后仍去写 store
  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
      if (zoomFrameRef.current !== null) cancelAnimationFrame(zoomFrameRef.current)
      if (dragFrameRef.current !== null) cancelAnimationFrame(dragFrameRef.current)
      if (pinchFrameRef.current !== null) cancelAnimationFrame(pinchFrameRef.current)
      // 触摸点表也要清：残留会让下一次挂载的第一次 pinch 用错的起始指距
      touchPointsRef.current.clear()
    },
    [],
  )
  // 最新图片集合：首屏 init 是异步的，init 之后要用「当前」的图片对账，不能靠闭包里的旧值
  const imagesRef = useRef(images)
  // 选中集同理：键盘 effect 只挂一次（[] 依赖），要用「当前」的选中集
  const selectedRef = useRef(selected)
  // 删除回调同理：父级传的是内联箭头（每次渲染换新引用），进依赖数组会让 keydown 监听每帧重挂
  const onRemoveImagesRef = useRef(onRemoveImages)

  // ⚠️ 这三个「最新值」ref 只能在 effect 里刷新，不能在渲染期直接赋值：
  // 渲染期写 ref 会被 react-hooks/refs 判为「Cannot access refs during render」——
  // 并发渲染下这次渲染可能被丢弃/重放，写入会落到不该落的那一次。
  // 不写依赖数组 ⇒ 每次提交后同步一次；下面读它们的地方（首屏 init 的异步回调、keydown 监听）
  // 都在事件/异步时机读，拿到的仍是「当前已提交」的最新值，语义与原先一致。
  useEffect(() => {
    imagesRef.current = images
    selectedRef.current = selected
    onRemoveImagesRef.current = onRemoveImages
  })

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
  /** 溯源层开关（代码里仍叫 lineage）：同上（默认关、不落库） */
  const [lineageOpen, setLineageOpen] = useState(false)
  /**
   * 「框选」模式开关：触屏上 `Shift` 的**等价物**（手指上没有修饰键）。
   * 刻意**不进 store**：它是瞬时交互模式，不是需要落库的画布状态（刷新后回到默认「平移」是合理的）。
   */
  const [marqueeMode, setMarqueeMode] = useState(false)
  /** 右键菜单：锚点是容器内屏幕坐标（与 marquee 同类，属瞬态，不入 store） */
  const [menu, setMenu] = useState<{ x: number; y: number; image: CanvasImage } | null>(null)
  /** 导入进行中 */
  const [importing, setImporting] = useState(false)
  /** 打包 zip 中（批量下载与画布归档共用） */
  const [zipping, setZipping] = useState(false)
  const importRef = useRef<HTMLInputElement | null>(null)
  /** 底部工具栏的溢出档位（0 = 全显示）。按实际宽度逐档收敛，见 TOOLBAR_LEVELS 的注释 */
  const [toolbarLevel, setToolbarLevel] = useState(0)
  const toolbarRef = useRef<HTMLDivElement | null>(null)

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
        useCanvasStore
          .getState()
          .init(topicId, draft ?? { images: [], meta: useCanvasStore.getState().meta }, draft ? 'local' : 'cloud')
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
      useCanvasStore.getState().applyServerPlacements((server?.images ?? []).filter((p) => rejectedSet.has(p.id)))
      showToast({ tone: 'warning', message: '另一处已更新，已同步为最新位置。' })
    })
  }, [placements, topicId])

  // 视口/背景变更提交：与位置**共用同一条防抖队列**（窗口结束合成一次 PATCH）。
  // ⚠️ 必须整份 meta 传进去：写成 `commitMeta(topicId, { meta })` 会多包一层 key，
  // 服务端 normalizeCanvasMeta 会把它当未知字段忽略 → 视口永远存不进去。
  // 失败由 persistence 内部兜住（离线时降级本地草稿），故这里无需 catch。
  // ⚠️ 用**非响应式订阅**而不是 `[meta]` 依赖：外层已不再订阅 meta（只订阅 background /
  // viewport.k / 有选中时的 viewport），若这里还依赖 meta，等于把整份 meta 的订阅又拉回来，
  // ③ 就白做了。回调里的判据与原来的 effect 完全一致。
  useEffect(() => {
    return useCanvasStore.subscribe((s, prev) => {
      if (s.meta === prev.meta) return // 值级短路已生效（①），不必回写
      if (!metaReadyRef.current) return // 快照未就位：默认 meta 不能回写（见 metaReadyRef 注释）
      if (loadedMetaRef.current === s.meta) return // 服务端值的回显，无需回写
      syncRef.current?.commitMeta(topicId, s.meta)
    })
  }, [topicId])

  // 灯箱关闭后还原焦点（沿用既有 CanvasBoard 的 setTimeout 手法，冒烟时发现）
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

  // ---------- 平移（普通左键 / 空格 / Ctrl / 中键 + 拖拽）与框选（Shift + 左键拖拽）----------
  //
  // ⚠️ 平移与框选**共用同一个手势**（左键在空白处拖拽），必须裁决（`lib/canvas/gesture.ts`）。
  // 上游 `.infinite-canvas-ref/.../infinite-canvas.tsx:114-135` 是「中键或空格/Ctrl+左键 = 平移；
  // 普通左键 = 框选」；**用户 2026-09-21 裁决把默认对调**：画布要能直接拖，
  // 于是「普通左键拖空白 = 平移；Shift + 左键拖空白 = 框选」，空格/Ctrl/中键的平移一律不变。
  // 代价是框选要按 Shift —— 故容器挂抓手光标 + `title` 提示两种手势（画布上没有别的手势说明位）。
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

  /**
   * 第二指落下时，把在飞的手势**作废**（不是提交）。
   *
   * ⚠️ 作废的语义边界（**注释里不写契约编号** —— 会被脱敏扫描命中）：
   *    `cancelGesture()` 只丢弃 history 的基准快照，**不会回滚**已经落到 store 的位移
   *    （卡片拖拽的 rAF 里是直接 `moveBy`）—— 所以图片会**停在落指瞬间的位置**，这是刻意的
   *    （让图弹回起点是惊吓式行为）。本函数保证的是「之后不再继续移动」。
   * ⚠️ 必须作废：接管后容器会把指针捕获从卡片迁到自己身上（setPointerCapture 后调用者胜），
   *    卡片的 pointerup 不再触发 ⇒ 不作废的话这个手势会**悬在 history 里**，
   *    第一次 Ctrl+Z 消费的就是它。作废语义与 `endCardDrag` 的 else 支一致。
   */
  const cancelInFlightGestures = useCallback(() => {
    if (dragRef.current) {
      dragRef.current = null
      pendingDragRef.current = null
      if (dragFrameRef.current !== null) {
        cancelAnimationFrame(dragFrameRef.current)
        dragFrameRef.current = null
      }
      useCanvasStore.getState().cancelGesture()
    }
    if (panRef.current) {
      panRef.current = null
      pendingPanRef.current = null
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
    }
    if (marqueeRef.current) {
      marqueeRef.current = null
      setMarquee(null)
    }
  }, [])

  /**
   * 把 pinch 的待处理帧**同步**补上。
   * ⚠️ 视口是 400ms 防抖落库的（`createCanvasPersistence(cloud, 400, local)`）——
   *    丢掉最后一个未 flush 的帧，落库的就是**过期视口**。
   *    这与 `endCardDrag`「先同步 flush 再 endGesture」是同一类处置。
   */
  const flushPinchFrame = useCallback(() => {
    if (pinchFrameRef.current !== null) {
      cancelAnimationFrame(pinchFrameRef.current)
      pinchFrameRef.current = null
    }
    const v = pendingPinchRef.current
    pendingPinchRef.current = null
    if (v) useCanvasStore.getState().setViewport(v)
  }, [])

  /**
   * 触摸点的跟踪必须在**捕获阶段**：卡片拖拽在 pointerdown 里 `stopPropagation()`，
   * 冒泡阶段收不到落在图片上的第一指 —— 而图片铺满画布 ⇒ 不用捕获阶段就基本捏不起来。
   *
   * ⚠️ 捕获阶段只做「跟踪 + 起 pinch」；被清掉的手势要靠 `onBackgroundPointerDown` 与
   *    `startCardDrag` 开头的 `pinchRef.current` 守卫阻止被**冒泡阶段重新武装**
   *    （容器同时挂了 onPointerDown，事件顺序是「容器捕获 → 目标 → 容器冒泡」）。
   */
  const onStagePointerDownCapture = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerType !== 'touch') return // 鼠标 / 触控笔走既有路径，零改动
      const el = containerRef.current
      if (!el) return
      // ⚠️ 与滚轮的豁免同口径：落在画布内的**弹层/控件**（选中工具栏、整理提示）上的触摸不参与手势 ——
      //    它们自带 `data-canvas-no-zoom`，且自己 `stopPropagation`（不设指针捕获）⇒
      //    收进表里也拿不到 pointerup，会留下永不抬起的幽灵点。
      const target = e.target instanceof Element ? e.target : null
      if (target?.closest('[data-canvas-no-zoom],[role="dialog"]')) return
      const rect = el.getBoundingClientRect()
      const pts = touchPointsRef.current
      // ⚠️ 已在跟踪两指时，**多余的指头一律不记**（不是「记了但不启动 pinch」）：
      //    若把第三指也记进来，它抬起后 pts 从 3 变 2、不满足收尾处的 `pts.size < 2` ⇒ pinch 不重置，
      //    而 `[...pts.values()]` 取的前两个已从 (指1,指2) 变成 (指2,指3) ⇒ 指距突变、视口跳变。
      if (pts.size >= 2) return
      pts.set(e.pointerId, { x: e.clientX - rect.left, y: e.clientY - rect.top })
      if (pts.size !== 2) return // 1 指交给冒泡阶段的既有平移
      cancelInFlightGestures()
      const [a, b] = [...pts.values()]
      pinchRef.current = pinchBegin(a, b, useCanvasStore.getState().meta.viewport)
      // 把两根手指的捕获都迁到容器（后调用者胜）。⚠️ 只吞 `NotFoundError`（该 pointer 已结束）；
      // 别的异常要让它冒出来，不要用空 catch 掩盖。
      for (const id of pts.keys()) {
        try {
          el.setPointerCapture(id)
        } catch (err) {
          if (!(err instanceof DOMException && err.name === 'NotFoundError')) throw err
        }
      }
    },
    [cancelInFlightGestures],
  )

  /**
   * 触摸点表的**兜底清理**：手指可能在容器**之外**抬起 —— 例如按在选中工具栏上（它在容器内，
   * 但自己 stopPropagation 且不设指针捕获），再把手指滑出画布抬手。那条路径的 pointerup
   * 不会冒泡到容器 ⇒ 表里会留一个永不抬起的幽灵点，下一次单指拖空白时表里变成 1+1=2、
   * 直接被当成捏合（视口跳变），且**不会自愈**直到组件重挂载。
   *
   * 所以清理挂在 window 上（捕获阶段）：任何 pointerup / pointercancel 都把该 id 摘掉。
   * ⚠️ 容器自己的收尾逻辑已由这里统一承担，不要在 `onBackgroundPointerUp` 里再写一遍
   * （重复写会让「谁负责清理」变得含糊，且 delete 的返回值在第二处恒为 false）。
   */
  useEffect(() => {
    const onUp = (e: PointerEvent) => {
      const pts = touchPointsRef.current
      if (!pts.delete(e.pointerId)) return
      if (pinchRef.current && pts.size < 2) {
        pinchRef.current = null
        flushPinchFrame()
      }
    }
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('pointercancel', onUp, true)
    return () => {
      window.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('pointercancel', onUp, true)
    }
  }, [flushPinchFrame])

  const onBackgroundPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // ⚠️ 第二指落下时 pinch 已接管（见 onStagePointerDownCapture）：同一个 pointerdown 会继续
      //    冒泡到这里，不拦的话会把 panRef 重新武装 ⇒ 抬指时走 `!pan.moved → clearSelection` 误清选中。
      if (pinchRef.current) return
      const el = containerRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const sx = e.clientX - rect.left
      const sy = e.clientY - rect.top
      const gesture = backgroundGesture({
        button: e.button,
        ctrlKey: e.ctrlKey,
        spaceHeld,
        shiftKey: e.shiftKey,
        marqueeMode,
      })
      if (gesture === 'none') return
      if (gesture === 'pan') {
        panRef.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, moved: false }
      } else if (gesture === 'marquee') {
        // 点击/拖空白：**先清空选中**（拖动后由框选命中重设）—— 沿用既有 CanvasBoard 的语义。
        // ⚠️ 清空必须放在这里而不是 pointerup：框选分支不建 panRef，放进 pointerup 就整条失效
        // （历史教训：这条曾因为写在「平移分支」的 pointerup 里而彻底不生效）。
        // 另注：平移分支的 pointerup 里也有一次「没移动就清空」，那是给「点空白」用的。
        useCanvasStore.getState().clearSelection()
        marqueeRef.current = { pointerId: e.pointerId, startX: sx, startY: sy, moved: false }
        setMarquee({ x1: sx, y1: sy, x2: sx, y2: sy, moved: false })
      }
      e.currentTarget.setPointerCapture(e.pointerId)
    },
    [spaceHeld, marqueeMode],
  )

  const onBackgroundPointerMove = useCallback((e: React.PointerEvent) => {
    // ---------- 双指手势（pinch 缩放 + 双指平移）----------
    const pts = touchPointsRef.current
    if (pts.has(e.pointerId)) {
      const el = containerRef.current
      if (el) {
        const rect = el.getBoundingClientRect()
        pts.set(e.pointerId, { x: e.clientX - rect.left, y: e.clientY - rect.top })
      }
    }
    const pinch = pinchRef.current
    if (pinch && pts.size >= 2) {
      const [a, b] = [...pts.values()] // 顺序无关：只用指距与中点
      const next = pinchUpdate(pinch, a, b)
      pinchRef.current = next.state
      if (next.viewport) {
        // 与平移不同：pinchUpdate 产出的是**绝对视口**，故只留最后一帧的值、不做增量累加
        pendingPinchRef.current = next.viewport
        if (pinchFrameRef.current === null) {
          pinchFrameRef.current = requestAnimationFrame(() => {
            pinchFrameRef.current = null
            const v = pendingPinchRef.current
            pendingPinchRef.current = null
            if (v) useCanvasStore.getState().setViewport(v)
          })
        }
      }
      return
    }

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
    setMarquee({ x1: m.startX, y1: m.startY, x2: sx, y2: sy, moved: true })
    // 实时命中预览：屏幕选框 → 世界坐标 → 与卡片矩形相交（沿用既有 hitTest 语义：贴边不算）
    const v = useCanvasStore.getState().meta.viewport
    const a = toWorld(Math.min(m.startX, sx), Math.min(m.startY, sy), { x: v.x, y: v.y, scale: v.k })
    const b = toWorld(Math.max(m.startX, sx), Math.max(m.startY, sy), { x: v.x, y: v.y, scale: v.k })
    const cards = Object.entries(useCanvasStore.getState().placements).map(([id, r]) => ({ id, rect: r }))
    useCanvasStore.getState().setSelected(hitTest(cards, { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y }))
  }, [])

  const onBackgroundPointerUp = useCallback((e: React.PointerEvent) => {
    // 双指手势的收尾（摘触摸点 + 补最后一帧）统一交给 window 级的 pointerup/pointercancel 兜底 ——
    // 手指可能在容器**之外**抬起，只靠这里会漏（见那段 effect 的注释）。
    // ⚠️ 下面的 `!pan.moved → clearSelection()` **不需要额外守卫**：pinch 开始时 panRef 已被
    //    cancelInFlightGestures() 清空，且 onBackgroundPointerDown 的守卫阻止了它被重新武装。
    const pan = panRef.current
    if (pan && pan.pointerId === e.pointerId) {
      // 平移（普通左键 / 空格 / Ctrl / 中键）但没移动 = 在空白处点了一下：同样清空选中
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

  const startCardDrag = useCallback((e: React.PointerEvent, img: CanvasImage) => {
    // ⚠️ pinch 接管期间不允许再起卡片拖拽：第二指若落在图片上，这个 pointerdown 会继续冒泡到
    //    卡片并重新武装 dragRef、抢走指针捕获 ⇒ 第二根手指变成在拖图。
    //    （pinchRef 是 ref，读 .current 不需要进依赖数组。）
    if (pinchRef.current) return
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
  }, [])

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
    // ⚠️ lastX/lastY 仍在**每个事件**里推进：增量之和与逐次调用数值等价（浮点 ≤1 ULP），
    // 只是把「一帧一次 moveBy」交给 rAF。moved 也必须在这里置位，否则 endCardDrag 会走
    // cancelGesture（点选语义）而不是 commit。
    drag.lastX = e.clientX
    drag.lastY = e.clientY

    const prev = pendingDragRef.current
    pendingDragRef.current = { dx: (prev?.dx ?? 0) + stepX, dy: (prev?.dy ?? 0) + stepY }
    if (dragFrameRef.current !== null) return
    dragFrameRef.current = requestAnimationFrame(() => {
      dragFrameRef.current = null
      const p = pendingDragRef.current
      pendingDragRef.current = null
      if (!p) return
      const d = dragRef.current
      if (!d) return // 手势已结束：位移由 endCardDrag 的同步 flush 负责，这里跳过
      useCanvasStore.getState().moveBy(d.ids, p.dx, p.dy)
    })
  }, [])

  const endCardDrag = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    dragRef.current = null
    const store = useCanvasStore.getState()
    if (drag.moved) {
      // ⚠️ 必须**先**把待处理的位移同步补上，再 endGesture：否则最后一次 pointermove 排的 rAF
      // 会在 endGesture 之后执行 moveBy，变成「手势已提交、位移又写回」（平移路径是丢弃未 flush
      // 的增量，这里选择**不丢位移**，故用同步 flush 而不是 cancel）。
      const p = pendingDragRef.current
      pendingDragRef.current = null
      if (dragFrameRef.current !== null) {
        cancelAnimationFrame(dragFrameRef.current)
        dragFrameRef.current = null
      }
      if (p) store.moveBy(drag.ids, p.dx, p.dy)
      store.endGesture()
    } else {
      // 只是点选（没拖动）：作废手势而不是入栈 —— 否则第一次 Ctrl+Z 会先消费这个「空步」
      // （看起来像撤销失灵），50 步上限也会被点选挤光
      store.cancelGesture()
    }
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

  /**
   * 「整理布局」：把所有图重排进空位槽并落库。抽成回调是因为**工具栏与「…」溢出菜单共用同一个动作**
   * （两处各写一份，改一处必漏另一处）。
   *
   * 2026-09-21 用户裁决：整块要**落在视口可见区的中间**（原来从视口左上角起铺，结果贴左上角）。
   * `stageSize` 是容器 CSS 像素，除以缩放才是世界坐标下的可见宽高；`k` 非正时按 1 处理，
   * 与 `viewportOrigin` 同一约定（那边注释里写了为什么绝不能产出 NaN/Infinity）。
   */
  const arrangeAll = useCallback(() => {
    const all = images.map((i) => i.id)
    useCanvasStore.getState().beginGesture('arrange')
    // 现读而非订阅：本函数是用户动作（按钮 / 溢出菜单），不需要跟着视口每帧重渲染
    const v = useCanvasStore.getState().meta.viewport
    const origin = viewportOrigin(v)
    // k 归一交给 baseScale：内联写 `v.k > 0 ? v.k : 1` 会漏掉 Infinity
    const k = baseScale(v.k)
    const slots = centerRectsInViewport(
      allocateSlots(
        [],
        images.map((i) => displaySize(i.width, i.height)),
        origin,
      ),
      origin,
      stageSize.w / k,
      stageSize.h / k,
    )
    useCanvasStore.getState().applyPlacements(slots.map((s, i) => rectToPlacement(all[i], s, new Date().toISOString())))
    useCanvasStore.getState().endGesture()
  }, [images, stageSize])

  /**
   * 工具栏溢出收敛：可用宽度 = 画布宽 − 24（工具栏的 max-width 就是这么算的）。
   * 每次可用宽度变化都**从 L0 重新开始**，再由下面那个 effect 逐档加收 ——
   * 单向递增保证不会来回震荡，最多 7 次渲染就稳定（不能改成双向：降一档是否装得下
   * 必须渲染完才量得到，会「降→溢出→升→装得下→降」无限循环）。
   *
   * ⚠️ 可用宽度先**防抖**再驱动收敛：收敛每档都要一次渲染，若直接拿每帧都在变的画布宽度驱动，
   * 拖窗口时 ResizeObserver 每帧触发，档位非 0 就会每帧多出最多 5 次全量重渲染（画布会抖）。
   * 抖动期间画布尺寸本来就在变，晚 120ms 定档肉眼无感。
   */
  // 小地图在场时左侧 240px 被它占掉（见 globals.css 那条 `:has()` 规则把工具栏右移）——
  // 收敛预算必须扣掉同一份宽度，否则工具栏「以为自己放得下」而实际溢出。
  // ⚠️ 口径必须与那条 CSS 一致：小地图组件是 `hidden lg:block`，窄屏虽在 DOM 里但不渲染。
  const minimapTakesSpace = miniMapOpen && stageSize.w >= 1024
  const rawToolbarAvail =
    stageSize.w > 0 ? stageSize.w - 24 - (minimapTakesSpace ? MINIMAP_W + 24 : 0) : Number.POSITIVE_INFINITY
  const [toolbarAvail, setToolbarAvail] = useState(Number.POSITIVE_INFINITY)
  useEffect(() => {
    if (!Number.isFinite(rawToolbarAvail)) {
      setToolbarAvail(rawToolbarAvail)
      return
    }
    const timer = setTimeout(() => setToolbarAvail(rawToolbarAvail), TOOLBAR_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [rawToolbarAvail])
  useEffect(() => {
    setToolbarLevel(0)
  }, [toolbarAvail])
  useEffect(() => {
    const el = toolbarRef.current
    if (!el || !Number.isFinite(toolbarAvail)) return
    if (el.scrollWidth > toolbarAvail && toolbarLevel < TOOLBAR_LEVELS.length - 1) {
      setToolbarLevel(toolbarLevel + 1)
    }
  }, [toolbarLevel, toolbarAvail])

  /** 当前档位下哪些单元还留在工具栏上（收走的那些会在「…」菜单里以文字项复现） */
  const hiddenUnits = new Set(TOOLBAR_LEVELS[toolbarLevel])
  const showStatusUnit = !hiddenUnits.has('status')
  const showMinimapUnit = !hiddenUnits.has('minimap')
  const showViewUnit = !hiddenUnits.has('view')
  const showMarqueeUnit = !hiddenUnits.has('marquee')
  const showArrangeUnit = !hiddenUnits.has('arrange')
  const showArchiveUnit = !hiddenUnits.has('archive')
  const showBackgroundUnit = !hiddenUnits.has('background')
  const showContentGroup = showArrangeUnit || showArchiveUnit

  /**
   * 溢出菜单里「撤销 / 重做」的可用性快照。
   *
   * ⚠️ **不能**在 render 期现读 `history.canUndo()`（本仓也没有 render 期现读 `getState()` 的先例）：
   * `history` 不是响应式的，而 `commit()` 发生在手势最后一次 `moveBy` **之后**、且**不触发重渲染** ——
   * 于是「拖完一张图」时那次渲染读到的仍是**提交前**的值，菜单项会一直显示置灰。
   * （实测：拖完卡片立刻打开菜单，撤销的 `aria-disabled` 仍是 `true`；要等下一次无关的重渲染才恢复。）
   * 改为**打开菜单时取一次**：那一刻的历史必然是最终值，且 setState 会让菜单项用新值渲染。
   */
  const [menuHistory, setMenuHistory] = useState({ canUndo: false, canRedo: false })
  const refreshMenuHistory = useCallback(() => {
    const h = useCanvasStore.getState().history
    setMenuHistory({ canUndo: h.canUndo(), canRedo: h.canRedo() })
  }, [])

  const selectedImages = useMemo(() => images.filter((i) => selected.includes(i.id)), [images, selected])

  /**
   * 容器宽 + 各浮动元素的占位。**必须有信号地重算**，不能只在选中张数变化时算一次：
   * 面板开合会真实增删 `.ws-canvas` 的子节点、窗口缩放会改容器宽，两者都会改变可用区间 ——
   * 不重算就会出现「钳过之后用户开了面板，工具栏又压在面板上」（#82 复审）。
   * 故：`ResizeObserver` 盯容器（窗口/布局变化）+ `MutationObserver` 盯 `.ws-canvas` 的 childList
   * （面板开合 = 直接子节点被换成收起条）。⚠️ 要盯的是 `.ws-canvas` 而不是 `containerRef` 的
   * `parentElement` —— 面板是 `.ws-canvas` 的子节点，中间还隔着本组件的根 div，盯错了永远不触发。
   * 两者都是低频事件，不会拖慢拖拽。
   */
  const [bandInput, setBandInput] = useState<{ width: number; panels: ToolbarPanelRect[] }>({ width: 0, panels: [] })
  useEffect(() => {
    const host = containerRef.current
    if (!host) return
    const measure = () => setBandInput(measureBandInput(host))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(host)
    const shell = host.closest('.ws-canvas')
    const mo = new MutationObserver(measure)
    if (shell) mo.observe(shell, { childList: true })
    return () => {
      ro.disconnect()
      mo.disconnect()
    }
  }, [])

  /**
   * 摆放矩形列表：`Object.values(placements)` 每次渲染都返回**新数组**，直接当 prop 传会击穿
   * `MiniMap` 里 `useMemo(..., [rects])` 的记忆（每帧重算包围盒 + 比例 + 全部方块）。
   */
  const rects = useMemo(() => Object.values(placements), [placements])

  /**
   * 「适应」：把全部内容放进视口。抽成回调是因为**工具栏与「…」溢出菜单共用同一个动作**
   * （窄屏下这个按钮会被收进菜单，两处各写一份必漏一处）。
   * 无图时是 no-op（`boundsOf` 返回 null）—— 与既有按钮行为一致。
   */
  const fitAll = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    const b = boundsOf(rects)
    if (!b) return
    useCanvasStore.getState().setViewport(fitView(b, el.clientWidth, el.clientHeight))
  }, [rects])

  /**
   * 溯源层（UI 文案；代码里叫 lineage）：**只在开关打开时**推导（关着时一次都不算）。
   *
   * 画什么全由 `lineageLayerModel` 判定（无 jsdom 的测试环境里组件路径测不到，判定必须可单测）；
   * 返回 `null` 表示整层都不挂载。`messages` 每次长轮询都会换新数组，故依赖它。
   */
  const lineageImages = useMemo(
    () => images.map((i) => ({ id: i.id, messageId: i.messageId, serial: i.serial, origin: i.origin })),
    [images],
  )
  /** 树形布局要显示尺寸：与空位槽分配用同一个 `displaySize`，保证排出来的卡片尺寸不变 */
  const lineageTreeImages = useMemo(
    () =>
      images.map((i) => ({ id: i.id, messageId: i.messageId, serial: i.serial, size: displaySize(i.width, i.height) })),
    [images],
  )
  /** 溯源推导（`deriveLineage`）：图层与树形布局共用同一份（都只在开关打开时算） */
  const lineage = useMemo(
    () => (lineageOpen ? deriveLineage({ images: lineageImages, messages }) : null),
    [lineageOpen, lineageImages, messages],
  )
  /**
   * 树形布局的锚点：**当前内容的包围盒左上角 + 竖直中心**，而不是视口原点。
   *
   * 这样计划**不随视口漂移**（平移/缩放后不会算出另一棵树），于是「整理」是幂等的：
   * 整理完内容包围盒就等于树的包围盒，再算一次结果逐值相同 ⇒ 引导自动消失。
   */
  const treeOrigin = useMemo(() => {
    const b = boundsOf(rects)
    // 兜底只在「画布无图」时生效（此时整理引导本就不出现）⇒ 用现读，不必随视口重算
    return b ? { x: b.x, y: b.y + b.h / 2 } : viewportOrigin(useCanvasStore.getState().meta.viewport)
  }, [rects])

  /** 树形布局的目标位置（只在溯源打开时算；点「按来源整理」时才落库） */
  const treePlan = useMemo(
    () => (lineage ? layoutLineageTree({ images: lineageTreeImages, lineage, origin: treeOrigin }) : []),
    [lineage, lineageTreeImages, treeOrigin],
  )
  /**
   * 引导提示：**当前摆放与树形布局差得明显**时才出现。
   *
   * 判据用 `isSameLayout` 配一个「轻推容差」（80 世界单位）：手工微调过、或本来就排成树的，
   * 偏差在容差内 ⇒ 不提示（否则用户每动一下卡片都被念一遍）；而与树形明显不符（按行铺的网格、
   * 或成环那种「排完也不一样」的极端形状）则如实提示。
   *
   * 早先用的是「边方向判据」（目标没明显排在源右边）：它对「一轮只有 1–3 张、恰好排在源右侧
   * 同一行」的网格会漏报，改为现在这条。
   */
  const TREE_HINT_TOLERANCE = 80
  const showTreeHint = useMemo(
    () => (lineage && treePlan.length > 0 ? !isSameLayout(treePlan, placements, TREE_HINT_TOLERANCE) : false),
    [lineage, treePlan, placements],
  )

  /**
   * 按来源整理：把树形布局落库。
   *
   * 走既有的 `beginGesture`/`endGesture`（与「整理布局」同一条路），所以 **Ctrl+Z 能撤销**；
   * 位置提交沿用既有的 400ms 防抖队列，不新增持久化管线。整理后把整棵树放进视野，
   * 否则用户只会看到树的一角。
   */
  const arrangeByLineage = useCallback(() => {
    if (treePlan.length === 0) return
    const store = useCanvasStore.getState()
    const now = new Date().toISOString()
    store.beginGesture('arrange')
    store.applyPlacements(treePlan.map((p) => rectToPlacement(p.id, p.rect, now)))
    store.endGesture()
    const el = containerRef.current
    const bounds = boundsOf(treePlan.map((p) => p.rect))
    if (el && bounds) store.setViewport(fitView(bounds, el.clientWidth, el.clientHeight))
    showToast({
      tone: 'success',
      message: (
        <>
          已按来源重新排列 {treePlan.length} 张（
          {/* 撤销键 Mac 上是 ⌘、Win/Linux 上是 Ctrl（见 lib/canvas/shortcuts.ts 的 isModifierShortcut），
              故双写。
              ⚠️ 两个键帽之间那个 `{' '}` 不能省：键帽之间的空隙只来自 `.kbd` 自己的 padding，
              不会进 DOM 文本 —— 少了它，复制出去和读屏读到的都是 `⌘/CtrlZ`（粘在一起）。 */}
          <Kbd>
            <Kbd.Content>⌘/Ctrl</Kbd.Content>
          </Kbd>{' '}
          <Kbd>
            <Kbd.Content>Z</Kbd.Content>
          </Kbd>{' '}
          可撤销）
        </>
      ),
    })
  }, [treePlan])

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
        archiveImages: images.map((i) => ({
          id: i.id,
          serial: i.serial,
          name: i.name,
          src: i.src,
          mimeType: i.mimeType,
        })),
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
      // ⚠️ 这里**不能**用「只认 ApiError」的判据：上面取图失败时抛的是**中文**
      // `Error('导出失败：有图片取不到（HTTP N）。')`（非 ApiError），只认 ApiError 会把它
      // 换成泛化的「导出失败。」，丢掉「哪张图取不到、什么状态码」这条有效信息。
      // `errorMessage` 的判据是「message 含中文才透传」—— 既保住上面这条中文原因，
      // 又把离线时 fetch 自身 reject 出的英文原文（`TypeError: Failed to fetch`）换成下面的中文兜底。
      showToast({ tone: 'danger', message: errorMessage(err, '导出失败。') })
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
        const { applied, skipped } = mergeImportedPlacements(
          currentPlacements(),
          parsed.images,
          new Date().toISOString(),
        )
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
        else if (skipped.length > 0)
          showToast({
            tone: 'warning',
            message: `已恢复 ${applied.length} 张，${skipped.length} 张因图片不存在被跳过。`,
          })
        // 位置落库走共用防抖队列（约 400ms 后发一次 PATCH），所以这里只说「已恢复」，
        // 不承诺已写进服务端；被 LWW 拒掉的情况由提交回调单独提示
        else showToast({ tone: 'success', message: `已恢复 ${applied.length} 张图的位置。` })
      } catch (err) {
        // 归档解析（`lib/zip` / `lib/canvas/archive` / `lib/canvas/serialization`）故意抛**中文** `Error`
        //（如「导入失败：不是画布归档（缺少 canvas.json）。」），`errorMessage` 会透传；
        // 英文原文（如离线时的 `Failed to fetch`）则回落下面的中文兜底。
        showToast({ tone: 'danger', message: errorMessage(err, '导入失败。') })
      } finally {
        setImporting(false)
      }
    },
    [topicId, currentPlacements],
  )

  const onArchiveAction = useCallback(
    async (key: string) => {
      if (key === 'export') await onExportArchive()
      else if (key === 'import') importRef.current?.click()
    },
    [onExportArchive],
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
      else if (action === 'regenerate') onRegenerate(target)
      else if (action === 'download') downloadImage(target)
      else onRemoveImages([target]) // 删除：走 Workspace 的二次确认
    },
    [menu, onAddReferences, onRemoveImages, downloadImage, onRegenerate],
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
        }),
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
        /* 抓手光标是「这里可以直接拖」的天然提示；手势说明挂 title（画布上没有别的手势说明位） */
        title="左键拖拽平移画布 · Shift+左键拖拽框选 · 滚轮缩放 · 空格/Ctrl+左键也可平移"
        /* 顶栏仍是占位式（高 64px），故画布最小高度 = 视口高 − 64 */
        style={{
          minHeight: 'calc(100dvh - 64px)',
          cursor: spaceHeld ? 'grabbing' : marqueeMode ? 'crosshair' : 'grab',
        }}
        onPointerDownCapture={onStagePointerDownCapture}
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
          // ⚠️ preventDefault 必须留在**同步**阶段：一旦挪进 rAF，浏览器已经开始滚动，
          // 缩放会与页面滚动同时发生。
          e.preventDefault()

          const el = containerRef.current
          if (!el) return
          if (e.deltaY === 0) return
          const rect = el.getBoundingClientRect()
          // 同帧累积：步数累加，锚点取**本帧最后一个事件**的坐标（语义 = 以最后指针位置为中心）。
          // 一帧只 flush 一次 ⇒ 连续滚轮不再每事件重渲染一次（实测 19ms/次）。
          const prev = pendingZoomRef.current
          pendingZoomRef.current = {
            steps: (prev?.steps ?? 0) + (e.deltaY < 0 ? 1 : -1),
            anchorX: e.clientX - rect.left,
            anchorY: e.clientY - rect.top,
          }
          if (zoomFrameRef.current !== null) return
          zoomFrameRef.current = requestAnimationFrame(() => {
            zoomFrameRef.current = null
            const p = pendingZoomRef.current
            pendingZoomRef.current = null
            if (!p || p.steps === 0) return
            // 一次算总倍率 ⇒ 缩放总量与逐次缩放等价（`zoomStepsToFactor` 有单测钉住可加性）
            useCanvasStore.getState().zoomAt(zoomStepsToFactor(p.steps), p.anchorX, p.anchorY)
          })
        }}
      >
        <CanvasWorld
          images={images}
          skeletons={skeletons}
          lineage={lineage}
          onCardPointerDown={startCardDrag}
          onCardPointerMove={onCardPointerMove}
          onCardPointerUp={endCardDrag}
          onCardDoubleClick={setPreview}
          onCardContextMenu={onCardContextMenu}
        />

        {/* 框选选框（屏幕坐标覆盖层） */}
        {marquee?.moved && (
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

        <SelectionToolbar
          selectedImages={selectedImages}
          placements={placements}
          bandInput={bandInput}
          zipping={zipping}
          onPreview={setPreview}
          onAddReferences={onAddReferences}
          onRegenerate={onRegenerate}
          onRemoveImages={onRemoveImages}
          onDownloadZip={downloadSelectedAsZip}
        />
      </div>

      {/* 引导：溯源打开、且当前摆放与来源明显不一致时给一条**可点的**提示（点它就整理）。
          不做自动重排：切视图开关就改动用户手工摆的位置是惊吓式行为。
          ⚠️ 位置是**底部工具栏正上方居中**（2026-09-21 调整）：画布上方那一条现在是顶部两条浮动条
          （Workspace 里）的地盘，左右两侧又各有一条浮动面板（top-64..bottom-64），
          只有「底部工具栏上方」这一块在任何面板开合状态下都不会被盖住，
          而且它指向的「按来源整理」按钮就在正下方的工具栏里 —— 提示与出口在同一处。 */}
      {showTreeHint && (
        <div className="pointer-events-none absolute bottom-[80px] left-1/2 -translate-x-1/2">
          {/* 「布局与来源不一致」这句**是提示的正文**而不是按钮标签 —— 换成图标 + Tooltip 会把
              「出问题了」这个信号藏进悬停里，正好废掉这条提示的作用。故保留文字，只补图标做视觉对齐 */}
          <Button
            size="sm"
            variant="secondary"
            className="pointer-events-auto"
            data-canvas-no-zoom
            onPress={arrangeByLineage}
          >
            <LayoutCellsLarge />
            布局与来源不一致 · 按来源整理
          </Button>
        </div>
      )}

      {/* 小地图：默认关，开关在工具栏的视图组。组件自身是 `hidden lg:block`（240px 宽在手机上占掉近半屏），
          故**开关按钮也必须只在 lg 以上出现** —— 否则窄屏点得动却什么都不会出现。
          ⚠️ 位置是**左下角**（见 MiniMap.tsx 的 `bottom-3 left-3`）：那里原本会被左侧浮动面板盖住，
          现在由面板让位（`globals.css` 里小地图在场时把 `.ws-float-left` 的 bottom 抬到 184px）。
          工具栏这边则由一条 `:has()` 规则**右移半个小地图宽** —— 两边都不压住它。 */}
      {miniMapOpen && stageSize.w > 0 && (
        <MiniMap size={stageSize} onJump={(v) => useCanvasStore.getState().setViewport(v)} />
      )}

      {/* 图片右键菜单：锚点用容器内坐标（Dropdown 自己负责贴边翻转） */}
      <CanvasContextMenu
        anchor={menu ? { x: menu.x, y: menu.y } : null}
        onClose={() => setMenu(null)}
        onAction={onMenuAction}
      />

      {/* 底部工具栏：**水平居中贴底**，按用途分组（2026-09-21 用户裁决：原在右下角、
          内容与视图混在一簇；【整理布局】【画布归档】也由右上角并入此处；画布状态读数由左上角并入此处）。
          分组顺序 = 「先看读数，再调视图，再摆内容，最后改外观」：
            ① 画布状态  ② 视图缩放  ③ 视图开关  ④ 内容操作  ⑤ 画布背景  ⑥ 溢出菜单
          ⚠️ **不换行**：放不下的项按 TOOLBAR_LEVELS 收进「…」下拉（窄屏仍能点到全部功能）。 */}
      <Toolbar ref={toolbarRef} className="canvas-zoombar" aria-label="画布工具栏" data-canvas-no-zoom>
        {/* ① 画布状态读数（原画布左上角的 pill）。「N 张图片」是纯读数；
            「本地草稿」是数据来源警示；「已选 N」带一个清空按钮。
            ⚠️ 它是**第一个被收走的单元**（纯信息，窄屏下给操作让位）；收走后「清空选择」
            在「…」菜单里有等价项，两处必须成对改。 */}
        {showStatusUnit && (
          <>
            <div className="canvas-status">
              <InlineText type="body-sm" className="canvas-status-count">
                {images.length} 张图片
              </InlineText>
              {/* 待生成张数（#88）：与「N 张图片」分列 —— 骨架**不计入**图片统计，
              这条读数才是「还有几张在生成」，让「4 张在生成、已出来 2 张」一眼可见。 */}
              {skeletons.length > 0 && (
                <>
                  <span className="canvas-status-divider" />
                  <InlineText
                    type="body-sm"
                    style={{ color: 'var(--muted-strong)' }}
                    data-testid="canvas-pending-count"
                  >
                    生成中 {skeletons.length} 张
                  </InlineText>
                </>
              )}
              {source === 'local' && (
                <>
                  <span className="canvas-status-divider" />
                  <InlineText style={{ color: 'var(--muted-strong)' }} type="body-sm" data-testid="canvas-local-draft">
                    本地草稿
                  </InlineText>
                </>
              )}
              {selected.length > 0 && (
                <>
                  <span className="canvas-status-divider" />
                  <InlineText style={{ color: 'var(--muted-strong)' }} type="body-sm">
                    已选 {selected.length}
                  </InlineText>
                  <IconButton
                    size="sm"
                    variant="ghost"
                    label="清空选择"
                    onPress={() => useCanvasStore.getState().clearSelection()}
                  >
                    <CircleXmark />
                  </IconButton>
                </>
              )}
            </div>
            <span className="canvas-tool-divider" />
          </>
        )}
        {/* ② 视图缩放 */}
        <ButtonGroup>
          <IconButton size="sm" variant="secondary" label="缩小" onPress={() => zoomAtCenter(1 / ZOOM_STEP)}>
            <Minus />
          </IconButton>
          {/* 百分比保留文字：它是**状态读数**，图标化等于把缩放比例删掉。
              读数与 `k` 的订阅都在组件里 —— 留在外层会让**缩放**逐帧重渲染整棵卡片子树。 */}
          <CanvasZoomReadout />
          <IconButton size="sm" variant="secondary" label="放大" onPress={() => zoomAtCenter(ZOOM_STEP)}>
            <Plus />
          </IconButton>
        </ButtonGroup>
        <span className="canvas-tool-divider" />
        {/* ③ 视图开关：都是「看得见什么」的开关，不改动内容。
            ⚠️ 「适应」与「溯源」属于**同一个收敛单元 `view`**（排在「框选」之前被收走）——
            收走后必须在「…」菜单里补等价项，两处必须成对改（契约 C11）。 */}
        {showViewUnit && (
          <IconButton size="sm" variant="ghost" label="适应" tooltip="适应窗口" onPress={fitAll}>
            <Frame />
          </IconButton>
        )}
        {showMinimapUnit && (
          <IconButton
            size="sm"
            variant={miniMapOpen ? 'primary' : 'ghost'}
            label="小地图"
            aria-pressed={miniMapOpen}
            /* hidden lg:inline-flex：与 MiniMap 自身的 `hidden lg:block` 对齐（见上方注释） */
            className="hidden lg:inline-flex"
            onPress={() => setMiniMapOpen((v) => !v)}
          >
            <MapPin />
          </IconButton>
        )}
        {/* 溯源层开关（UI 文案；代码里叫 lineage）：**不加 `hidden lg:inline-flex`** —— 它不是 240px 的面板，窄屏也能用
            （与小地图开关的区别就在这：那个开关必须与组件自身的断点对齐） */}
        {showViewUnit && (
          <IconButton
            size="sm"
            variant={lineageOpen ? 'primary' : 'ghost'}
            label="溯源"
            aria-pressed={lineageOpen}
            onPress={() => setLineageOpen((v) => !v)}
          >
            <Hierarchy />
          </IconButton>
        )}
        {/* ③b 「框选」模式开关（触屏上 Shift 的等价物）：**手势模式**，与视图开关不是一类，故自带一条分隔线。
            ⚠️ 它是**最后一个被收走的单元** —— 支持的四档（393/375/360/320）都不许走到那一档，
            走到就意味着触屏上框选仍不可达（见 TOOLBAR_LEVELS 的注释）。
            ⚠️ 分隔线跟着 `showViewUnit` 走而不是无条件渲染：在「视图开关已被收走」的档位上，
            前面只剩缩放组，再插一条就会与缩放组后面那条连成**两条相邻的分隔线**。
            ⚠️ 图标不用 `SquareDashed` —— 那个已经被「空白」背景态占用了，两处同图会歧义。
            本仓既有的 ToggleButton 都配 ToggleButtonGroup（选中态由 group context 驱动），
            这是**首个独立** ToggleButton：受控 `isSelected` / `onChange` 是官方用法。 */}
        {showMarqueeUnit && (
          <>
            {showViewUnit && <span className="canvas-tool-divider" />}
            <Tooltip delay={0}>
              <ToggleButton size="sm" aria-label="框选" isSelected={marqueeMode} onChange={setMarqueeMode}>
                <Crop />
              </ToggleButton>
              <Tooltip.Content>框选</Tooltip.Content>
            </Tooltip>
          </>
        )}
        {/* ④ 内容操作：会**改写摆放**或**读写文件**，与上面那些纯视图开关不是一类，故单列一组。
            ⚠️ 整理布局与按来源整理是**两件事**，不合并成一个下拉：
            前者按网格空位重排、后者按溯源树形铺开，误操作的代价是用户手工摆的位置被覆盖。 */}
        {showContentGroup && <span className="canvas-tool-divider" />}
        {showArrangeUnit && (
          <>
            <IconButton
              size="sm"
              variant="ghost"
              label="整理布局"
              tooltip="把所有图片重排进网格空位"
              onPress={arrangeAll}
            >
              <LayoutCellsLarge />
            </IconButton>
            {/* 按来源整理：只在溯源打开时出现（不打开溯源就没必要谈「按来源排」）。
                它**不自动触发** —— 开关只管显示线，重排必须由用户点（切视图开关就偷改摆放是惊吓式行为） */}
            {lineageOpen && (
              <IconButton
                size="sm"
                variant={showTreeHint ? 'primary' : 'ghost'}
                label="按来源整理"
                tooltip="按溯源关系树形铺开"
                isDisabled={treePlan.length === 0}
                onPress={arrangeByLineage}
              >
                <LayoutCellsLarge />
              </IconButton>
            )}
          </>
        )}
        {/* 画布归档（导出/导入）。⚠️ 触发件用 Dropdown 的**直接子元素**（官方 default demo 的写法）：
            `Dropdown.Trigger` 内部会再渲染一个 HeroUI Button，写成 `<Trigger><Button/></Trigger>`
            会得到 `<button>` 套 `<button>`（React 19 报 validateDOMNesting，且 isDisabled 落在内层、
            靠冒泡被吃掉才偶然生效）。
            ✅ Tooltip 与 Dropdown 触发件**可以共存**（2026-09-21 运行时实证）：MenuTrigger 经
            PressResponderContext 下发 trigger props、并原样渲染 children（不 clone Element），React context
            会穿过 Tooltip —— 实测 aria-haspopup/aria-expanded 正常接线、菜单正常开合、Tooltip 正常浮现 */}
        {showArchiveUnit && (
          <>
            <Dropdown>
              <IconButton
                size="sm"
                variant="ghost"
                label={zipping ? '打包中…' : importing ? '导入中…' : '画布归档'}
                isDisabled={zipping || importing}
              >
                {zipping || importing ? <ArrowRotateRight className="animate-spin" /> : <Archive />}
              </IconButton>
              {/* 工具栏贴底，菜单向上弹才不会盖住画布底部（placement 交给 HeroUI 自动翻转也行，
                  但显式 top 更稳：底部工具栏的可用空间只在上方） */}
              <Dropdown.Popover placement="top end">
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
          </>
        )}
        {/* 隐藏的 file input **必须始终挂载**：溢出菜单在 showArchiveUnit 为 false（窄屏档位 ≥3）时
            仍提供「导入画布（zip）」项，而它的动作是 `importRef.current?.click()` ——
            input 若随归档单元一起卸载，窄屏点这一项就是静默无反应（无 toast 无日志）。 */}
        <input
          ref={importRef}
          type="file"
          accept=".zip,application/zip"
          hidden
          onChange={(e) => void onImportFile(e.target.files?.[0] ?? null)}
        />
        {/* ⑤ 画布背景：纯外观，放最后 */}
        {showBackgroundUnit && (
          <>
            <span className="canvas-tool-divider" />
            <ToggleButtonGroup
              aria-label="网格样式"
              selectionMode="single"
              selectedKeys={new Set([background])}
              onSelectionChange={(keys) => {
                const next = BACKGROUND_OPTIONS.find((o) => o.key === [...keys][0])
                if (next) useCanvasStore.getState().setBackground(next.key)
              }}
            >
              {/* ToggleButton 不走 IconButton：它是另一个组件（选中态由 ToggleButtonGroup 的 context 驱动），
                  但同样能被 Tooltip 直接包住 —— ToggleButtonGroup 不 clone 子元素、只提供 context
                  （toggle-button-group.js 的 Root 原样透传 children），context 会穿过 Tooltip，CSS 也仍按后代选择器命中 */}
              {BACKGROUND_OPTIONS.map((o) => (
                <Tooltip key={o.key} delay={0}>
                  <ToggleButton id={o.key} size="sm" aria-label={o.label}>
                    {o.icon}
                  </ToggleButton>
                  <Tooltip.Content>{o.label}</Tooltip.Content>
                </Tooltip>
              ))}
            </ToggleButtonGroup>
          </>
        )}
        {/* ⑥ 溢出菜单：被收走的那些单元在这里**以文字菜单项**复现（动作与按钮上的是同一个 handler）。
            ⚠️ 背景三态在菜单里用「当前项带 ✓」表达选中态 —— Dropdown.Menu 的 selectionMode 是整菜单级的，
            与「其余项是纯动作」混在一起会把动作项也变成可选项，语义不对。 */}
        {toolbarLevel > 0 && (
          <>
            <span className="canvas-tool-divider" />
            <Dropdown
              onOpenChange={(open) => {
                // 打开时取一次历史快照（见 `menuHistory` 的注释：render 期现读会拿到提交前的旧值）
                if (open) refreshMenuHistory()
              }}
            >
              <IconButton size="sm" variant="ghost" label="更多画布操作">
                <Ellipsis />
              </IconButton>
              <Dropdown.Popover placement="top end">
                <Dropdown.Menu
                  onAction={(key) => {
                    const k = String(key)
                    if (k === 'arrange') return arrangeAll()
                    if (k === 'arrange-lineage') return arrangeByLineage()
                    if (k === 'export' || k === 'import') return void onArchiveAction(k)
                    // 视图开关被收走时的等价入口（与工具栏那两个按钮共用同一个实现）
                    if (k === 'fit') return fitAll()
                    if (k === 'toggle-lineage') return setLineageOpen((v) => !v)
                    if (k === 'toggle-minimap') return setMiniMapOpen(false)
                    // 键盘专属功能（撤销 / 重做 / 全选 / 清空选择）在工具栏里**本来就没有按钮**，
                    // 这里照抄键盘分支的同一实现。
                    if (k === 'undo') return useCanvasStore.getState().undo()
                    if (k === 'redo') return useCanvasStore.getState().redo()
                    if (k === 'select-all') return useCanvasStore.getState().setSelected(images.map((i) => i.id))
                    if (k === 'clear-selection') return useCanvasStore.getState().clearSelection()
                    if (k.startsWith('bg:')) {
                      const mode = BACKGROUND_OPTIONS.find((o) => o.key === k.slice(3))
                      if (mode) useCanvasStore.getState().setBackground(mode.key)
                    }
                  }}
                >
                  {/* ⚠️ 小地图的兜底项**只在它真的开着时**出现。原来这里一项都没有，理由是
                      「菜单只在溢出时打开，而溢出意味着画布宽 < ~533px（工具栏自身只要 509px），
                      那时小地图组件（`hidden lg:block`）根本不渲染，加一项只会是『点得动却什么都不发生』」。
                      但那条推理现在不成立了：① 收敛预算已经把「小地图占的 240px」扣掉（见 `minimapTakesSpace`），
                      面板开着时 1024 视口也会溢出；② 此时 `minimap` 单元可能被收走，而小地图面板还开着
                      —— 没有这个入口用户就**关不掉它**。
                      条件写成 `miniMapOpen` 而不是无条件：旧注释那条「不出现点不动的项」的性质仍然保留。 */}
                  {!showMinimapUnit && miniMapOpen && (
                    <Dropdown.Item id="toggle-minimap" textValue="关闭小地图">
                      <Label>关闭小地图</Label>
                    </Dropdown.Item>
                  )}
                  {!showArrangeUnit && (
                    <Dropdown.Item id="arrange" textValue="整理布局">
                      <Label>整理布局</Label>
                    </Dropdown.Item>
                  )}
                  {!showArrangeUnit && lineageOpen && (
                    <Dropdown.Item id="arrange-lineage" textValue="按来源整理">
                      <Label>按来源整理</Label>
                    </Dropdown.Item>
                  )}
                  {!showArchiveUnit && (
                    <Dropdown.Item id="export" textValue="导出画布（zip）">
                      <Label>导出画布（zip）</Label>
                    </Dropdown.Item>
                  )}
                  {!showArchiveUnit && (
                    <Dropdown.Item id="import" textValue="导入画布（zip）">
                      <Label>导入画布（zip）</Label>
                    </Dropdown.Item>
                  )}
                  {!showBackgroundUnit &&
                    BACKGROUND_OPTIONS.map((o) => (
                      <Dropdown.Item key={o.key} id={`bg:${o.key}`} textValue={`背景 ${o.label}`}>
                        <Label>{background === o.key ? `✓ 背景 · ${o.label}` : `背景 · ${o.label}`}</Label>
                      </Dropdown.Item>
                    ))}
                  {/* 视图开关被收走时的等价入口：与工具栏那两个按钮是**同一对**，改一处必须改两处。
                      可用性不受 history / 选中数影响，故不置灰。 */}
                  {!showViewUnit && (
                    <Dropdown.Item id="fit" textValue="适应">
                      <Label>适应</Label>
                    </Dropdown.Item>
                  )}
                  {!showViewUnit && (
                    <Dropdown.Item id="toggle-lineage" textValue="溯源">
                      <Label>{lineageOpen ? '✓ 溯源' : '溯源'}</Label>
                    </Dropdown.Item>
                  )}
                  {/* 键盘专属功能的触屏入口：这三项在工具栏里**本来就没有按钮**，故不受档位条件限制
                      （菜单本身仍只在 toolbarLevel > 0 时渲染）。可用性按打开菜单那一刻的历史快照置灰
                      （`menuHistory`，见它的定义 —— **不能**在 render 期现读 `history`：`commit()` 在
                      最后一次 `moveBy` 之后且不触发重渲染，现读会拿到提交前的旧值）。 */}
                  <Dropdown.Item id="undo" textValue="撤销" isDisabled={!menuHistory.canUndo}>
                    <Label>撤销</Label>
                  </Dropdown.Item>
                  <Dropdown.Item id="redo" textValue="重做" isDisabled={!menuHistory.canRedo}>
                    <Label>重做</Label>
                  </Dropdown.Item>
                  <Dropdown.Item id="select-all" textValue="全选" isDisabled={images.length === 0}>
                    <Label>全选</Label>
                  </Dropdown.Item>
                  {/* 读数区被收走时，「已选 N」旁的「清空选择」按钮也一起没了 ⇒ 这里补一个等价入口 */}
                  {!showStatusUnit && selected.length > 0 && (
                    <Dropdown.Item id="clear-selection" textValue="清空选择">
                      <Label>清空选择</Label>
                    </Dropdown.Item>
                  )}
                </Dropdown.Menu>
              </Dropdown.Popover>
            </Dropdown>
          </>
        )}
      </Toolbar>

      {/* 屏幕阅读器图片清单 */}
      <ul className="sr-only">
        {images.map((img) => (
          <li key={img.id}>
            #{String(img.serial).padStart(3, '0')} {img.name}
          </li>
        ))}
      </ul>

      {/* 灯箱预览（HeroUI Modal 容器；点背景/✕/Esc 关闭）。
          2026-09-21 用户裁决：预览**只要「蒙层 + 图片 + 关闭按钮」**，不要 HeroUI 默认那层白色卡片 ——
          把 Dialog 自身的底色/边框/阴影/内边距都去掉（`className` 是 HeroUI 的公开出口，
          文档的 modal/custom-styles demo 就是这么改的，不算「覆盖组件内部样式」）。
          ⚠️ `w-fit` 不能省：Dialog 默认 `w-full`，透明之后图片左右会各留一片「点了没反应」的空白 ——
          那片空白属于 Dialog，点它**不**触发 backdrop 的 isDismissable。w-fit 让盒子贴住图片，
          图片之外的点就都落在蒙层上 → 能关。
          `rounded-none` 同理不能省：Dialog 自带圆角，底色去掉后 `overflow: hidden` 会照着那个圆角
          把图片的角裁圆（用户 2026-09-21 反馈「图片上面有两个圆角」），预览的图片必须是直角。 */}
      {preview && (
        <Modal.Backdrop
          isOpen
          onOpenChange={(open) => {
            if (!open) setPreview(null)
          }}
        >
          <Modal.Container>
            <Modal.Dialog
              aria-label="图片预览"
              className="w-fit max-w-[min(920px,92vw)] rounded-none border-0 bg-transparent p-0 shadow-none"
            >
              {/* 不写 children：HeroUI 的 CloseButton 缺省就渲染自带 CloseIcon（close-button.js 里
                  `children ?? <CloseIcon/>`），手写「✕」字形属于自造图标 */}
              <Modal.CloseTrigger aria-label="关闭预览" />
              {/* `m-0 p-0` 必须成对：HeroUI 给 `.modal__body` 写了 `margin:-3px; padding:3px`
                  （一负一正互相抵消，让内容贴齐 dialog）。只去 padding 会剩负 margin ——
                  body 反而比 dialog 宽 6px，图片被 dialog 的 `overflow:clip` 左右各裁 3px。
                  `m-0` 同时压掉 `.modal__body{margin-top:8px}`。 */}
              <Modal.Body className="m-0 p-0">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={preview.src}
                  alt={preview.name}
                  onClick={(e) => e.stopPropagation()}
                  style={{ display: 'block', maxWidth: '100%', maxHeight: '72vh' }}
                />
              </Modal.Body>
              {/* 2026-09-21 用户裁决：预览不要说明文字（「只需要有个蒙层和图片就好」+ 一个关闭按钮）。
                  原先那行「#003 名称 · W×H」挂在 `Modal.Footer` 里，去掉它顺带消掉
                  `.modal__body + .modal__footer{margin-top:20px}` 那条 20px 透明死区。 */}
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      )}
    </div>
  )
}

export { CanvasStage }
