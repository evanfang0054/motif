'use client'

/**
 * 画布世界层：背景图案 + 世界层（溯源 SVG、待生成骨架槽、图片卡片）。
 *
 * ## 为什么拆成两层
 *
 * 平移时**只有世界层的 `transform` 变**，卡片的位置其实没变。但 `meta.viewport` 每帧都变，
 * 谁订阅它谁就每帧重渲染。实测（生产构建、20 张图、平移 60 次）的教训：
 * 只把「画布 chrome」移出 viewport 的订阅路径**收益为零**（`ScriptDuration` 0.455s → 0.4697s），
 * 因为那 7.8ms/事件的纯 JS 成本**全在 20 张图片卡片的逐帧 reconcile 上**。
 *
 * 所以这里分两层：
 * - `CanvasWorld`（本层）：**不订阅 viewport**，只订阅 `placements` / `selected`；卡片在这里创建。
 * - `WorldLayer`（内层）：订阅 `viewport` / `background`，只重渲染「一个 transform div + 网格层 + 溯源 SVG」，
 *   卡片作为 `children` 原样透传。
 *
 * ⇒ 平移时 `CanvasWorld` 不重渲染 ⇒ `children` 的元素引用不变 ⇒ React 跳过整棵卡片子树。
 * ⚠️ 别把卡片挪回 `WorldLayer` 内部 —— 那样又回到「每帧 reconcile 20 张卡片」。
 *
 * ## 红线
 *
 * class 名与 `data-testid` 与拆分前**一字不改**。下面这些钩子被 `e2e/run.sh`、
 * `e2e/acceptance.sh` 与单测同时锚定：
 * `.canvas-img-card` / `.canvas-skeleton-card` / `.canvas-img-card[aria-busy="true"]` /
 * `data-testid="canvas-grid"` / `data-testid="canvas-lineage"`。
 */
import { useMemo, type ReactNode } from 'react'
import { Skeleton } from '@heroui/react'
import type { CanvasImage } from '@motif/core'
import type { Rect } from '@/lib/canvas/geometry'
import { gridStyle } from '@/lib/canvas/grid'
import { lineageLayerModel, type Lineage } from '@/lib/canvas/lineage'
import type { PendingSkeleton } from '@/lib/canvas/skeleton'
import { useCanvasStore } from '@/stores/canvas/useCanvasStore'

interface Props {
  images: CanvasImage[]
  skeletons: PendingSkeleton[]
  /** 由外层算好传下来：它只依赖 lineageOpen / images / messages，与 viewport 无关 */
  lineage: Lineage | null
  onCardPointerDown: (e: React.PointerEvent, img: CanvasImage) => void
  onCardPointerMove: (e: React.PointerEvent) => void
  onCardPointerUp: (e: React.PointerEvent) => void
  onCardDoubleClick: (img: CanvasImage) => void
  onCardContextMenu: (e: React.MouseEvent, img: CanvasImage) => void
}

function CanvasWorld({
  images,
  skeletons,
  lineage,
  onCardPointerDown,
  onCardPointerMove,
  onCardPointerUp,
  onCardDoubleClick,
  onCardContextMenu,
}: Props) {
  // ⚠️ 本层**不订阅 viewport**（只订阅摆放与选中）—— 这正是让卡片避开平移重渲染的关键。
  const placements = useCanvasStore((s) => s.placements)
  const selected = useCanvasStore((s) => s.selected)

  const cards = (
    <>
      {/* 待生成骨架槽：服务端下发的计划槽，与出图落位**同坐标** → 出图就地填入不跳动。
          骨架**不是画布图片**：不进 `placements` / `images`，故不参与选中、框选、删除、灯箱、
          归档导出、「N 张图片」统计与整理布局；`pointer-events: none` 让它不响应手势。
          几何口径**如实说明**：`displaySize ≤ 240×240` + 槽步长 280 只保证**网格相邻槽
          之间**不重叠，不是「绝不会压到相邻图」。两处残余风险：① 出图比例 ≠ 请求比例时
          （请求 800×600 → 计划 240×180，网关返回 800×800 → 实际 240×240，高度多 60px）可能压到
          **用户手拖的图**；② 生成期间用户拖动/导入会让入队时算的计划槽相对现状失效。①由 worker
          落位前的相交校验兜住（撞上就退回 `allocateSlots`，见 services.ts）—— 此时该骨架会
          「跳位」到新槽后消失，代价远小于压图；②的骨架占位在落位前仍可能与手拖图短暂重叠，
          落位后同样跳位。这里**刻意不给骨架加 width/height transition**：骨架挂载期间尺寸恒定，
          那个 transition 是死代码（会误导后来人以为尺寸在动）。 */}
      {skeletons.map((s) => (
        <figure
          key={`sk-${s.messageId}-${s.index}`}
          // 与图片卡片共用 `.canvas-img-card` 只为复用其绝对定位；额外挂 `.canvas-skeleton-card`
          // 作为**纯标记类**（无任何 CSS）把「骨架」与「图片卡片」区分开 —— 取「第一张图片卡片 /
          // 数图片张数」的选择器都必须排除它，否则会取到 `pointer-events:none` 的骨架
          //（拖拽无位移、计数虚高）。见 e2e/acceptance.sh 的 `.canvas-img-card:not(...)`。
          className="canvas-img-card canvas-skeleton-card"
          style={{
            left: s.rect.x,
            top: s.rect.y,
            width: s.rect.w,
            height: s.rect.h,
            margin: 0,
            pointerEvents: 'none',
          }}
          aria-busy="true"
          aria-label={`正在生成第 ${s.ordinal} 张`}
        >
          {/* 骨架本体用 HeroUI 的 Skeleton（shimmer），不自研控件 */}
          <Skeleton className="h-full w-full rounded-[10px]" />
        </figure>
      ))}
      {images.map((img) => {
        const p = placements[img.id]
        if (!p) return null
        const isSel = selected.includes(img.id)
        return (
          <figure
            key={img.id}
            className={`canvas-img-card canvas-img-in${isSel ? ' canvas-img-card-selected' : ''}`}
            style={{ left: p.x, top: p.y, width: p.w, margin: 0, cursor: 'grab' }}
            onPointerDown={(e) => onCardPointerDown(e, img)}
            onPointerMove={onCardPointerMove}
            onPointerUp={onCardPointerUp}
            onDoubleClick={() => onCardDoubleClick(img)}
            onContextMenu={(e) => onCardContextMenu(e, img)}
            aria-label={`#${String(img.serial).padStart(3, '0')} ${img.name}`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={img.src}
              alt={img.name}
              draggable={false}
              loading="lazy"
              style={{ width: '100%', display: 'block' }}
            />
            <figcaption className="canvas-img-label">
              #{String(img.serial).padStart(3, '0')} {img.name}
              {img.origin === 'uploaded' ? ' · 参考图' : ''}
            </figcaption>
          </figure>
        )
      })}
    </>
  )

  return (
    <WorldLayer lineage={lineage} placements={placements}>
      {cards}
    </WorldLayer>
  )
}

/**
 * 订阅 viewport 的那一层：只渲染「网格层 + 一个 transform div（内含溯源 SVG）」，卡片由 `children` 透传。
 * 平移时本组件重渲染，但 `children` 是同一个元素对象 ⇒ React 不会进入卡片子树。
 */
function WorldLayer({
  lineage,
  placements,
  children,
}: {
  lineage: Lineage | null
  placements: Record<string, Rect>
  children: ReactNode
}) {
  const viewport = useCanvasStore((s) => s.meta.viewport)
  const background = useCanvasStore((s) => s.meta.background)

  const grid = useMemo(() => gridStyle(background, viewport), [background, viewport])
  // ⚠️ 溯源层必须在这里算：线宽是 `strokeWidth = 1.5 / viewport.k`，依赖 viewport。
  const lineageLayer = useMemo(
    () => (lineage ? lineageLayerModel({ lineage, placements, k: viewport.k }) : null),
    [lineage, placements, viewport.k],
  )

  return (
    <>
      {/* 背景图案：照抄上游 CanvasGrid（图案联动视口），底色取中性 --canvas-background */}
      {grid && <div className="pointer-events-none absolute inset-0" style={grid} data-testid="canvas-grid" />}

      {/* 世界层 */}
      <div
        className="absolute left-0 top-0"
        style={{
          transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.k})`,
          transformOrigin: '0 0',
        }}
      >
        {/* 溯源层（UI 文案；代码里叫 lineage）：与世界层同一 transform ⇒ 线与框粘在卡片上，缩放平移都不用重算。
            只读（pointer-events: none），在卡片**之前**渲染 ⇒ 永远在卡片之下。
            ⚠️ 尺寸必须显式非零：世界层没有宽高、子元素全是绝对定位 ⇒ 父盒实际 0×0，
            而 SVG 宽或高为 0 时按规范**禁用渲染**（整层会不可见）。1×1 + overflow: visible
            足以画出任意坐标（含负坐标）的图元，不需要量世界的包围盒。
            ⚠️ 线宽用 1.5 / k 而不是 vector-effect="non-scaling-stroke"：缩放来自祖先的
            CSS transform，non-scaling-stroke 只抵消「元素 → SVG 视口」那段 CTM，抵不掉它。
            分组框标签的字号与世界偏移**不除以 k**，跟卡片 caption 一样随缩放变化（既有口径）。 */}
        {lineageLayer && (
          <svg
            aria-hidden
            data-testid="canvas-lineage"
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              width: 1,
              height: 1,
              overflow: 'visible',
              pointerEvents: 'none',
            }}
          >
            {lineageLayer.groups.map((g) => (
              <g key={g.key}>
                <rect
                  x={g.rect.x}
                  y={g.rect.y}
                  width={g.rect.w}
                  height={g.rect.h}
                  rx={12}
                  style={{ fill: 'none', stroke: 'var(--border)', strokeDasharray: '6 6', strokeWidth: 1 / viewport.k }}
                />
                <text x={g.rect.x + 8} y={g.rect.y - 6} style={{ fill: 'var(--muted)', fontSize: 12 }}>
                  {g.label}
                </text>
              </g>
            ))}
            {lineageLayer.edges.map((e) => (
              <path
                key={e.key}
                d={e.d}
                style={{ fill: 'none', stroke: 'var(--border)', strokeWidth: 1.5 / viewport.k }}
              />
            ))}
          </svg>
        )}
        {children}
      </div>
    </>
  )
}

export { CanvasWorld }
