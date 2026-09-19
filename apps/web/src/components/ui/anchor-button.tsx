/**
 * HeroUI Button render 回调的 props 为按钮类型；锚点化时整体做一次按钮→锚点的类型矫正。
 * 运行时 ref 随 props 由 React 19 透传到 <a>，press/焦点接线完整保留，此处仅类型层面转换。
 * 用法：<Button variant="primary" render={anchorRender({ href: '/', onClick })}>文案</Button>
 */
export const anchorRender =
  <A extends { href: string }>(extra: A) =>
  (p: React.ComponentPropsWithRef<'button'>) => {
    const anchorProps = p as unknown as React.ComponentPropsWithRef<'a'> & A
    return <a {...anchorProps} {...extra} />
  }
