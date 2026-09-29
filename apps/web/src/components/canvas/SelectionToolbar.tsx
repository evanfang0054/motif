'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Toolbar } from '@heroui/react'
import { ArrowDownToLine, ArrowRotateLeft, ArrowRotateRight, ArrowsExpand, At, TrashBin } from '@gravity-ui/icons'
import { IconButton } from '@/components/ui/icon-button'
import { InlineText } from '@/components/ui/typography'
import { anchorRender } from '@/components/ui/anchor-button'
import { clampToolbarCenter, toolbarAnchor, toolbarBand, type ToolbarPanelRect } from '@/lib/canvas/viewport'
import { useCanvasStore, type Placements } from '@/stores/canvas/useCanvasStore'
import type { CanvasImage } from '@motif/core'

interface Props {
  selectedImages: CanvasImage[]
  placements: Placements
  bandInput: { width: number; panels: ToolbarPanelRect[] }
  zipping: boolean
  onPreview: (img: CanvasImage) => void
  onAddReferences: (imgs: CanvasImage[]) => void
  onRegenerate: (img: CanvasImage) => void
  onRemoveImages: (imgs: CanvasImage[]) => void
  onDownloadZip: () => void
}

/**
 * 选中浮动工具栏（单选与多选两套按钮）。
 *
 * 为什么单独成组件：它需要**整个 viewport**（锚点要算），而 `CanvasStage` 若订阅它，
 * 「有选中平移」时外层会**每帧**重渲染 ⇒ 重建 20 张卡片的 `children` ⇒ 卡片逐帧 reconcile。
 * 挪进来后，条件订阅只在**有选中**时成立，重渲染的代价只有这一小块工具栏。
 *
 * ⚠️ 尺寸测量 effect（`floatToolbarRef` + `toolbarBox`）与锚点/横向钳制的 `useMemo`
 *    **必须留在这里**：它们都依赖 `toolbarViewport` 与工具栏自身尺寸。搬回外层会让
 *    「工具栏定位静默失效」（钳不出可用区间，工具栏被两侧面板压住）。
 * ⚠️ `bandInput`（容器宽 + 面板占位）仍由外层测量后传进来 —— 它依赖外层的 `containerRef`。
 */
export function SelectionToolbar({
  selectedImages,
  placements,
  bandInput,
  zipping,
  onPreview,
  onAddReferences,
  onRegenerate,
  onRemoveImages,
  onDownloadZip,
}: Props) {
  /** 条件订阅：无选中时选择器恒返回 `null`，`Object.is(null, null)` 为真 ⇒ 不重渲染 */
  const toolbarViewport = useCanvasStore((s) => (s.selected.length > 0 ? s.meta.viewport : null))
  /** 选中浮动工具栏本体（只为量尺寸）；单选与多选是同一个 ref（两者互斥渲染） */
  const floatToolbarRef = useRef<HTMLDivElement | null>(null)

  /**
   * 浮动工具栏自身的尺寸（参与横向钳制；高度用于判断与面板是否纵向重叠）。
   *
   * 只在「选中张数变化」时量一次：尺寸只随工具栏内容与字体变，不随缩放/平移变，
   * 跟着 viewport 量会在每次拖拽里读一次布局（强制重排）。
   * 单张与多选是两套按钮（多选还带「已选 N 张」），宽度不同 —— 都以张数为键，切换时自然重量。
   * ⚠️ 测量发生在 `useEffect`（paint 之后），所以首帧与「1 ↔ N 切换」的那一帧用的是**旧值/裸锚点**，
   * 下一帧才修正。改 `useLayoutEffect` 能消掉这一帧，但它在 SSR 下会告警，不值得。
   */
  const [toolbarBox, setToolbarBox] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = floatToolbarRef.current
    setToolbarBox(selectedImages.length > 0 && el ? { w: el.offsetWidth, h: el.offsetHeight } : { w: 0, h: 0 })
  }, [selectedImages.length])
  /**
   * 工具栏位置 = 锚点 + **横向钳制**。单选与多选共用同一条路径。
   *
   * 钳制的对象是「两侧浮动面板占掉之后剩下的横向区间」（见 `toolbarBand`）：被选图靠画布
   * 右缘时，工具栏右半原本会伸进生成面板的矩形里，而那半边的按钮就点不动了（#82）。
   * 多选的包围盒更宽、工具栏也更宽，同样会被裁 —— 故两条路径都必须钳。
   * 尺寸/占位还没量到时先按原锚点渲染，量到后就会修正。
   */
  const toolbarStyle = useMemo(() => {
    if (selectedImages.length === 0 || !toolbarViewport) return undefined
    const anchor = toolbarAnchor(
      selectedImages.map((i) => placements[i.id]),
      toolbarViewport,
    )
    if (!anchor) return undefined
    if (toolbarBox.w === 0 || bandInput.width === 0) return anchor
    const band = toolbarBand(bandInput.width, bandInput.panels, { top: anchor.top, height: toolbarBox.h })
    return { ...anchor, left: clampToolbarCenter(anchor.left, toolbarBox.w, band, bandInput.width) }
  }, [selectedImages, placements, toolbarViewport, toolbarBox, bandInput])

  // ⚠️ 必须在**全部 hook 之后**（提前 return 会违反 react-hooks/rules-of-hooks）
  if (selectedImages.length === 0) return null

  return (
    <>
      {/* 选中浮动工具栏（沿用既有 markup 与文案） */}
      {selectedImages.length === 1 && (
        <Toolbar
          ref={floatToolbarRef}
          aria-label="图片操作"
          className="canvas-toolbar"
          style={toolbarStyle}
          data-canvas-no-zoom
          onPointerDown={(e) => e.stopPropagation()}
        >
          <IconButton size="sm" variant="secondary" label="放大预览" onPress={() => onPreview(selectedImages[0])}>
            <ArrowsExpand />
          </IconButton>
          <IconButton
            size="sm"
            variant="secondary"
            label="@ 引用"
            ariaLabel="加入参考图，并把编号写进提示词"
            onPress={() => onAddReferences([selectedImages[0]])}
          >
            <At />
          </IconButton>
          {/* 与「@ 引用」的区别：这是**替换**画布引用并把该轮原始提示词填回表单（不是追加） */}
          <IconButton
            size="sm"
            variant="secondary"
            label="再生成"
            ariaLabel="按这张图那一轮的提示词重新填好表单，并把它设为参考图"
            onPress={() => onRegenerate(selectedImages[0])}
          >
            <ArrowRotateLeft />
          </IconButton>
          <IconButton
            size="sm"
            variant="secondary"
            label="下载"
            render={anchorRender({ href: selectedImages[0].src, download: selectedImages[0].name })}
          >
            <ArrowDownToLine />
          </IconButton>
          <span className="canvas-tool-divider" />
          <IconButton
            size="sm"
            variant="danger"
            label="删除所选图片"
            onPress={() => onRemoveImages([selectedImages[0]])}
          >
            <TrashBin />
          </IconButton>
        </Toolbar>
      )}
      {/* 多选批量工具栏（与单选共用 `toolbarStyle`，即同样做横向钳制） */}
      {selectedImages.length > 1 && (
        <Toolbar
          ref={floatToolbarRef}
          aria-label="批量操作"
          className="canvas-toolbar"
          style={toolbarStyle}
          data-canvas-no-zoom
          onPointerDown={(e) => e.stopPropagation()}
        >
          {/* 「已选 N 张」保留文字：它承载数字，换成图标会丢掉唯一的信息源 */}
          <InlineText type="body-sm" style={{ fontSize: 12, color: 'var(--muted)' }}>
            已选 {selectedImages.length} 张
          </InlineText>
          <span className="canvas-tool-divider" />
          <IconButton
            size="sm"
            variant="secondary"
            label="@ 引用"
            ariaLabel="把所选图片全部加入参考图"
            onPress={() => onAddReferences(selectedImages)}
          >
            <At />
          </IconButton>
          <IconButton
            size="sm"
            variant="secondary"
            label="批量下载（打包为 zip）"
            isDisabled={zipping}
            onPress={onDownloadZip}
          >
            {zipping ? <ArrowRotateRight className="animate-spin" /> : <ArrowDownToLine />}
          </IconButton>
          <span className="canvas-tool-divider" />
          <IconButton size="sm" variant="danger" label="删除所选图片" onPress={() => onRemoveImages(selectedImages)}>
            <TrashBin />
          </IconButton>
        </Toolbar>
      )}
    </>
  )
}
