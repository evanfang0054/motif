import { describe, expect, it } from 'vitest'
import { isTypingTarget, shortcutFor, NON_CANVAS_FOCUS_SELECTOR, type ShortcutInput } from '@/lib/canvas/shortcuts'

/** 默认：无修饰键、不在输入框内 */
function input(partial: Partial<ShortcutInput> & { key: string }): ShortcutInput {
  return { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, typing: false, ...partial }
}

describe('画布快捷键：键位判定', () => {
  it('Cmd/Ctrl+Z 撤销、Cmd/Ctrl+Shift+Z 重做、Cmd/Ctrl+Y 重做', () => {
    expect(shortcutFor(input({ key: 'z', ctrlKey: true }))).toBe('undo')
    expect(shortcutFor(input({ key: 'z', metaKey: true }))).toBe('undo')
    expect(shortcutFor(input({ key: 'z', ctrlKey: true, shiftKey: true }))).toBe('redo')
    expect(shortcutFor(input({ key: 'y', metaKey: true }))).toBe('redo')
  })

  it('大小写与 Shift 组合（Cmd+Shift+Z 时 key 是 "Z"）也能识别', () => {
    expect(shortcutFor(input({ key: 'Z', ctrlKey: true, shiftKey: true }))).toBe('redo')
  })

  it('Cmd/Ctrl+A 全选', () => {
    expect(shortcutFor(input({ key: 'a', metaKey: true }))).toBe('select-all')
  })

  it('Delete 与 Backspace 都映射为删除（且不要求修饰键）', () => {
    expect(shortcutFor(input({ key: 'Delete' }))).toBe('delete')
    expect(shortcutFor(input({ key: 'Backspace' }))).toBe('delete')
  })

  it('Escape 映射为 escape（不要求修饰键）', () => {
    expect(shortcutFor(input({ key: 'Escape' }))).toBe('escape')
  })

  it('按住 Alt 时组合键整体失效（防 AltGr 误触）', () => {
    expect(shortcutFor(input({ key: 'z', ctrlKey: true, altKey: true }))).toBeNull()
    expect(shortcutFor(input({ key: 'a', metaKey: true, altKey: true }))).toBeNull()
  })

  it('无修饰键的普通字母不拦截', () => {
    expect(shortcutFor(input({ key: 'a' }))).toBeNull()
    expect(shortcutFor(input({ key: 'z' }))).toBeNull()
    expect(shortcutFor(input({ key: 'F5' }))).toBeNull()
  })

  it('已裁掉的上游键位不再命中（编组 / 复制粘贴）', () => {
    expect(shortcutFor(input({ key: 'g', ctrlKey: true }))).toBeNull()
    expect(shortcutFor(input({ key: 'g', ctrlKey: true, shiftKey: true }))).toBeNull()
    expect(shortcutFor(input({ key: 'c', ctrlKey: true }))).toBeNull()
    expect(shortcutFor(input({ key: 'v', ctrlKey: true }))).toBeNull()
  })

  it('输入框内不拦截修饰键类动作（含全选与删除）', () => {
    for (const key of ['z', 'a', 'Delete', 'Backspace', 'y']) {
      expect(shortcutFor(input({ key, ctrlKey: true, typing: true }))).toBeNull()
      expect(shortcutFor(input({ key, typing: true }))).toBeNull()
    }
  })

  it('输入框内 **Esc 仍然生效**（关灯箱/清空选择不能被输入框豁免掉）', () => {
    expect(shortcutFor(input({ key: 'Escape', typing: true }))).toBe('escape')
  })
})

describe('画布快捷键：输入类元素判定', () => {
  it('node 环境（无 DOM 全局）下不抛错，返回 false', () => {
    // 测试环境是 environment: 'node'，没有 Element 全局 —— 必须走能力探测分支
    expect(typeof Element).toBe('undefined')
    expect(isTypingTarget(null)).toBe(false)
    expect(isTypingTarget({} as unknown as EventTarget)).toBe(false)
  })

  /**
   * DOM 选择器路径在 node 环境里跑不到（无 Element），但这条名单**出过两次事故**：
   * ① 曾经漏掉 HeroUI 的角色容器 → 焦点在菜单里按 Backspace 会弹删除框；
   * ② 曾经把 `[data-canvas-no-zoom]` 算进来 → 键盘聚焦画布视图簇后 Ctrl+A / Delete 静默失效。
   * 故这里直接钉住名单本身：改动它必须同步改这条断言（而不是无声地回归）。
   */
  it('豁免名单：含 HeroUI 角色容器（含 alertdialog），且**不含** data-canvas-no-zoom', () => {
    for (const role of ['listbox', 'menu', 'menuitem', 'radiogroup', 'checkbox', 'switch', 'dialog', 'alertdialog']) {
      expect(NON_CANVAS_FOCUS_SELECTOR).toContain(`[role='${role}']`)
    }
    expect(NON_CANVAS_FOCUS_SELECTOR).toContain("[contenteditable='true']")
    expect(NON_CANVAS_FOCUS_SELECTOR).toContain('[data-canvas-shortcuts-ignore]')
    // 反例：这个属性的语义是「滚轮别缩放」，与键盘无关 —— 加回来就会让 Ctrl+A / Delete 静默失效
    expect(NON_CANVAS_FOCUS_SELECTOR).not.toContain('data-canvas-no-zoom')
    // 也不该把 button 一并豁免（会把上面那个静默失效的 bug 原样带回来）
    expect(NON_CANVAS_FOCUS_SELECTOR).not.toContain('button')
  })
})
