/**
 * 画布快捷键的键位判定（纯函数，无 React 依赖，可单测）。
 *
 * 参考 `.infinite-canvas-ref/src/pages/canvas/project.tsx` 的键盘段（主快捷键表在那里，
 * 上游的 `lib/keyboard-event.ts` 只放 IME 判定、并未被主画布引用）。
 * 照抄的判定：`isModifierShortcut = metaKey || ctrlKey`（**含 Mac Cmd**）、组合键额外要求
 * `!altKey`、输入框内一律不拦截。
 *
 * 裁掉的上游键位（Motif 没有对应概念，照抄清单里已列为可砍项）：
 * - `Cmd/Ctrl+G` / `Cmd/Ctrl+Shift+G`：编组 / 解组（无 group 节点）
 * - `Delete` 的「删连线」分支、`Esc` 的连线 / 裁剪 / 蒙版 / 弹窗分支
 * - `Cmd/Ctrl+C` / `V`：复制粘贴（本轮裁决不做，理由见设计文档）
 */

export type CanvasShortcut = 'undo' | 'redo' | 'select-all' | 'delete' | 'escape'

export interface ShortcutInput {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  /** 焦点在输入类元素内（由调用方用 `isTypingTarget` 算好） */
  typing: boolean
}

/**
 * 输入类元素判定：3 个标签类型 + 组件角色/豁免选择器。
 * ⚠️ 无 jsdom 的测试环境里没有 `Element` / `HTMLInputElement` 全局，故先做能力探测，
 * 探测不到就返回 false（真实浏览器里分支正常）。
 *
 * 除原生输入元素外还要豁免 HeroUI 组件的角色容器：它们的可聚焦件是 `button` / `div[role]`，
 * 不豁免的话焦点在菜单或下拉里按 Backspace 会弹出删除确认框、Ctrl+A 会抢走全选。
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (typeof Element === 'undefined' || !(target instanceof Element)) return false
  if (typeof HTMLInputElement !== 'undefined' && target instanceof HTMLInputElement) return true
  if (typeof HTMLTextAreaElement !== 'undefined' && target instanceof HTMLTextAreaElement) return true
  if (typeof HTMLSelectElement !== 'undefined' && target instanceof HTMLSelectElement) return true
  return !!target.closest(
    "[contenteditable='true'],[data-canvas-no-zoom],[data-canvas-shortcuts-ignore]," +
      "[role='listbox'],[role='menu'],[role='menuitem'],[role='radiogroup'],[role='checkbox'],[role='switch'],[role='dialog']"
  )
}

/** 键位 → 动作；不认识的键返回 null（调用方据此放行） */
export function shortcutFor(input: ShortcutInput): CanvasShortcut | null {
  // ⚠️ Esc 必须在 typing 豁免**之前**：焦点在输入框里时按 Esc 仍要能关灯箱 / 清空选择。
  // 这是 P1 既有行为，上游同样是「先判 Esc 再豁免输入框」。
  if (input.key === 'Escape') return 'escape'
  if (input.typing) return null
  const key = input.key.toLowerCase()
  if (input.key === 'Delete' || input.key === 'Backspace') return 'delete'
  const mod = input.metaKey || input.ctrlKey
  if (!mod || input.altKey) return null
  if (key === 'z') return input.shiftKey ? 'redo' : 'undo'
  if (key === 'y') return 'redo'
  if (key === 'a') return 'select-all'
  return null
}
