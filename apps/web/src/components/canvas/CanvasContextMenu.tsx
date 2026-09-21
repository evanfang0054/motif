/**
 * 画布图片的右键菜单。
 *
 * 参考 `.infinite-canvas-ref/src/components/canvas/canvas-context-menu.tsx`（只照抄定位语义与菜单项组织）。
 * 与上游的差异（逐条）：
 * 1. 上游是 `position: fixed` + 手写浮层，**没有贴边翻转**；这里改用 HeroUI `Dropdown`（受控），
 *    锚点用同款「视口坐标 + fixed 的 0 尺寸 trigger」，贴边翻转由 `Dropdown.Popover` 继承的
 *    `shouldFlip`（默认 true）承担。
 * 2. 上游用第三方弹层的类名排除弹层、自己挂全局 `pointerdown` 关闭；Motif 无此概念，
 *    关闭交给 `onOpenChange` 与画布的 Esc。
 * 3. 菜单项按 Motif 的既有能力裁剪：只保留与单选浮动工具栏**逐项一致**的五项；
 *    上游的「复制 / 编组 / 解组 / 视频三帧」都不适用（无复制粘贴、无编组、无视频节点）。
 * 4. 危险项走 HeroUI 的 `variant="danger"`（映射到项目 `--danger` 桥接），不硬编码色值（上游硬编码 #f87171）。
 */
'use client'

import { Dropdown, Label } from '@heroui/react'
import { ArrowDownToLine, ArrowRotateLeft, ArrowsExpand, At, TrashBin } from '@gravity-ui/icons'

export type ContextMenuAction = 'preview' | 'reference' | 'regenerate' | 'download' | 'delete'

interface Props {
  /** 指针的**视口坐标**（clientX/clientY）；null 表示不显示 */
  anchor: { x: number; y: number } | null
  onClose: () => void
  onAction: (action: ContextMenuAction) => void
}

/**
 * 菜单项一律「图标 + 文字」而不是图标 + Tooltip：菜单项按规范必须带可见标签
 * （Dropdown.Item 也强制要 textValue），hover 才显字在菜单里既反直觉又拖慢扫读。
 * 图标写法照抄官方 demos/cn/dropdown/with-icons.tsx（图标 + Label 并列）。
 */
const ITEMS: Array<{ id: ContextMenuAction; label: string; icon: React.ReactNode; danger?: boolean }> = [
  { id: 'preview', label: '放大预览', icon: <ArrowsExpand className="size-4 shrink-0 text-muted" /> },
  { id: 'reference', label: '@ 引用', icon: <At className="size-4 shrink-0 text-muted" /> },
  { id: 'regenerate', label: '再生成', icon: <ArrowRotateLeft className="size-4 shrink-0 text-muted" /> },
  { id: 'download', label: '下载', icon: <ArrowDownToLine className="size-4 shrink-0 text-muted" /> },
  { id: 'delete', label: '删除', icon: <TrashBin className="size-4 shrink-0 text-danger" />, danger: true },
]

function CanvasContextMenu({ anchor, onClose, onAction }: Props) {
  return (
    <Dropdown
      isOpen={anchor !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      {/* 指针锚点：`Dropdown.Trigger` 内部渲染的是 HeroUI `Button`，所以**锚点必须是 trigger 自己**
          （把 span 塞进 trigger 会被包进一个按钮里，菜单会锚到那个按钮的流式位置 —— 实测被钉到容器底部）。
          故这里让 trigger 变成一个 0 尺寸、不可见、不吃事件的 fixed 按钮，坐标用**视口坐标**。
          `pointer-events-none` 避免它抢走画布的指针事件。 */}
      <Dropdown.Trigger
        aria-label="图片操作"
        /* excludeFromTabOrder：菜单关着时它是 0 尺寸不可见按钮，不该被 Tab 走到 */
        excludeFromTabOrder
        className="pointer-events-none fixed h-0 w-0 min-w-0 border-0 p-0 opacity-0"
        style={{ left: anchor?.x ?? 0, top: anchor?.y ?? 0 }}
      />
      <Dropdown.Popover placement="bottom start" offset={4}>
        <Dropdown.Menu onAction={(key) => onAction(key as ContextMenuAction)}>
          {ITEMS.map((item) => (
            <Dropdown.Item key={item.id} id={item.id} textValue={item.label} variant={item.danger ? 'danger' : 'default'}>
              {item.icon}
              <Label>{item.label}</Label>
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  )
}

export { CanvasContextMenu }
