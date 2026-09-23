'use client'

import { Typography } from '@heroui/react'
import type { ComponentProps, ReactElement } from 'react'

type TypographyProps = Omit<ComponentProps<typeof Typography>, 'render'>

/**
 * `Typography` 的**行内形态**：视觉走 HeroUI 的 `type`，底层元素仍是 `<span>`。
 *
 * 为什么需要它：`Typography` 没有 `as` prop，唯一的元素逃生口是 `render`。而 `type="body*"`
 * 渲染的是**块级 `<p>`** —— 直接套在行内文本上会把排版撑开。本仓有 90+ 处行内文本，
 * 逐处手写 `render={({children, ...domProps}) => <span {...domProps}>{children}</span>}`
 * 既啰嗦又容易写歪，故收口到这一个组件。
 *
 * ⚠️ 它会带上 `type` 的字号/行高（`body` = 16px/28px 等）。**放进 `Button`/`Chip` 等自带文字
 * 样式的控件里时**，两者同优先级，胜负由样式表顺序决定 —— 那种场景请先实测再决定是否使用。
 */
function InlineText({ children, ...props }: TypographyProps): ReactElement {
  return (
    <Typography
      {...props}
      render={({ children: kids, ...domProps }) => <span {...domProps}>{kids}</span>}
    >
      {children}
    </Typography>
  )
}

export { InlineText }
