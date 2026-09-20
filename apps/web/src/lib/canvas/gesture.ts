/**
 * 画布空白处的手势裁决：同一个「左键在空白处拖拽」既可能是平移、也可能是框选，必须裁决。
 *
 * 照抄 `.infinite-canvas-ref/src/components/canvas/infinite-canvas.tsx:114-135`：
 *   `temporaryTool = ctrlKey || isSpacePressed`
 *   `shouldPan = button === 1 || (button === 0 && activeTool === 'pan' && isBackgroundClick)`
 * 即：**中键、或「空格/Ctrl + 左键」= 平移视图；普通左键 = 框选**。
 *
 * 之所以抽成纯函数：这个裁决曾经把框选整条分支写死（平移分支先 return），
 * 而组件层没有单测覆盖 —— 抽出来后可以用真值表钉住。
 */

export type BackgroundGesture = 'pan' | 'marquee' | 'none'

export interface PointerModifiers {
  /** PointerEvent.button：0=左键，1=中键，2=右键 */
  button: number
  ctrlKey: boolean
  spaceHeld: boolean
}

/** 空白处按下时该走哪条手势；'none' = 不接管（右键等） */
export function backgroundGesture({ button, ctrlKey, spaceHeld }: PointerModifiers): BackgroundGesture {
  if (button === 1) return 'pan'
  if (button !== 0) return 'none'
  return ctrlKey || spaceHeld ? 'pan' : 'marquee'
}
