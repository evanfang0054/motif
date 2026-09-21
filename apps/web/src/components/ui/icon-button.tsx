'use client'

/**
 * 图标按钮：HeroUI Button（isIconOnly）+ Tooltip 的统一封装。
 *
 * 为什么要封装：图标化之后按钮上不再有可见文字，标签只能靠 Tooltip 与 aria-label 两条腿承载
 * （Tooltip 给看得见的人，aria-label 给读屏），分散手写必然漏掉其中一条。
 *
 * ⚠️ Tooltip 必须**直接包住** Button —— HeroUI v3 的 Tooltip 是 React Aria 的 TooltipTrigger，
 * 靠 clone 直接子元素注入 ref 与 aria-describedby。写成 `<Tooltip.Trigger><Button/></Tooltip.Trigger>`
 * 会得到 `<div role="button">` 套 `<button>`（源码 dist/components/tooltip/tooltip.js 实证：
 * TooltipTrigger 渲染的是带 role="button" 的 div，不是透传包装）。
 * ✅ 它**可以**包住 Dropdown 的触发件（2026-09-21 运行时实证，此前一度误判为「结构上不能共存」）：
 * DropdownRoot 是 RAC 的 MenuTrigger，它把 trigger props 经 **PressResponderContext** 下发、并**原样渲染
 * children**（`react-aria-components/private/Menu.mjs` 里 `grep cloneElement` 命中 0），而 React context
 * 会穿过 Tooltip —— 实测 `<Dropdown><IconButton/><Dropdown.Popover/></Dropdown>` 的
 * aria-haspopup / aria-expanded 接线正常、菜单正常开合、Tooltip 也正常浮现。
 *
 * delay={0}：HeroUI 默认 --tooltip-delay 是 1500ms（@heroui/styles themes/default/variables.css:50），
 * 对「图标即唯一标签」的场景等于没有提示；官方 icon-only demo（demos/cn/tooltip/basic.tsx）同样传 0。
 */
import { BUTTON_GROUP_CHILD, Button, Tooltip } from '@heroui/react'

type ButtonProps = React.ComponentProps<typeof Button>

interface Props extends Omit<ButtonProps, 'isIconOnly' | 'aria-label' | 'children'> {
  /**
   * 短名：缺省同时充当 aria-label 与 Tooltip 文案。
   * ⚠️ 三者是**有意允许分歧**的，不是必须一致：`label` 是视觉/读屏的默认名，`ariaLabel` 给读屏更精确的
   * 指代（如「移除画布引用 商品主图.png」），`tooltip` 给视觉用户更长的说明（如「适应窗口」）。
   * 分歧时要保证二者**说的是同一件事**，别一个讲动作、一个讲结果。
   */
  label: string
  /** 读屏需要更精确的指代时覆盖 aria-label；Tooltip 仍用 label 的短文案 */
  ariaLabel?: string
  /** 需要更长的说明时才传；缺省与 label 相同 */
  tooltip?: string
  /** Tooltip 方位；工具栏贴边场景可指定，缺省交给 HeroUI 自动翻转 */
  placement?: 'top' | 'bottom' | 'left' | 'right'
  children: React.ReactNode
}

function IconButton({ label, ariaLabel, tooltip, placement, children, ...rest }: Props) {
  return (
    <Tooltip delay={0}>
      {/* 透传 BUTTON_GROUP_CHILD 标记：ButtonGroup 只认**直接子元素**（ButtonGroupRoot 用 cloneElement
          给直接子元素打标记，Button 侧 `shouldUseContext = isButtonGroupChild === true` —— 见
          dist/components/button-group/button-group.js:36-44 与 button.js:25），Tooltip 包一层就把标记吃掉了。
          ⚠️ 被吃掉的只是「从组继承 size/variant/isDisabled」这一条；组内贴边圆角与边框合并走的是 CSS 后代
          选择器 `.button-group .button:first-child`（@heroui/styles button-group.css），而 Tooltip 不落 DOM，
          所以视觉不受影响。标记是 HeroUI 的公开出口，补回来即可与裸 Button 行为完全一致。
          不在组里时传它也无副作用：默认 context 是空对象，各字段仍回落到按钮自身的 props。 */}
      {/* `||` 而不是 `??`：传空串时 `??` 不拦，会产出空的可访问名 */}
      <Button isIconOnly aria-label={ariaLabel || label} {...{ [BUTTON_GROUP_CHILD]: true }} {...rest}>
        {children}
      </Button>
      <Tooltip.Content placement={placement}>{tooltip ?? label}</Tooltip.Content>
    </Tooltip>
  )
}

export { IconButton }
