/**
 * 画布空白处的手势裁决：同一个「左键在空白处拖拽」既可能是平移、也可能是框选，必须裁决。
 *
 * 照抄 `.infinite-canvas-ref/src/components/canvas/infinite-canvas.tsx:114-135`：
 *   `temporaryTool = ctrlKey || isSpacePressed`
 *   `shouldPan = button === 1 || (button === 0 && activeTool === 'pan' && isBackgroundClick)`
 * 即上游是「中键、或空格/Ctrl + 左键 = 平移；普通左键 = 框选」。
 *
 * ⚠️ **用户 2026-09-21 裁决把默认对调**：画布要能直接拖（否则「怎么拖都拖不动」），
 * 故改为「**普通左键拖空白 = 平移**；**Shift + 左键拖空白 = 框选**」。
 * 两种手势都保留、且空格/Ctrl/中键的平移一律不变（向后兼容）；
 * 代价是框选从「默认」变成「要按 Shift」——所以画布容器上挂了抓手光标与 `title` 提示。
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
  /** 框选的触发键（默认对调后，框选改由它承担） */
  shiftKey: boolean
}

/** 空白处按下时该走哪条手势；'none' = 不接管（右键等） */
export function backgroundGesture({ button, ctrlKey, spaceHeld, shiftKey }: PointerModifiers): BackgroundGesture {
  if (button === 1) return 'pan'
  if (button !== 0) return 'none'
  // 空格 / Ctrl + 左键恒为平移（上游口径，保留不动）
  if (ctrlKey || spaceHeld) return 'pan'
  return shiftKey ? 'marquee' : 'pan'
}
