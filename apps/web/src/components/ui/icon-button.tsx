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
 * 同理它**不能**包 Dropdown：DropdownRoot 是 RAC 的 MenuTrigger，不落 DOM、不透传 props，
 * Tooltip 会静默失效（dist/components/dropdown/dropdown.js:19-30）—— 需要下拉的触发件另想办法。
 *
 * delay={0}：HeroUI 默认 --tooltip-delay 是 1500ms（@heroui/styles themes/default/variables.css:50），
 * 对「图标即唯一标签」的场景等于没有提示；官方 icon-only demo（demos/cn/tooltip/basic.tsx）同样传 0。
 */
import { BUTTON_GROUP_CHILD, Button, Tooltip } from '@heroui/react'

type ButtonProps = React.ComponentProps<typeof Button>

interface Props extends Omit<ButtonProps, 'isIconOnly' | 'aria-label' | 'children'> {
  /** Tooltip 文案，同时作为 aria-label（二者必须一致，否则读屏与视觉用户看到的不是同一个东西） */
  label: string
  /** 读屏需要更精确的指代（如「移除画布引用 商品主图.png」）时覆盖 aria-label；Tooltip 仍用 label 的短文案 */
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
      <Button isIconOnly aria-label={ariaLabel ?? label} {...{ [BUTTON_GROUP_CHILD]: true }} {...rest}>
        {children}
      </Button>
      <Tooltip.Content placement={placement}>{tooltip ?? label}</Tooltip.Content>
    </Tooltip>
  )
}

export { IconButton }
