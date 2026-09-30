import { describe, expect, it } from 'vitest'
import { backgroundGesture } from '@/lib/canvas/gesture'

const mods = (over: Partial<Parameters<typeof backgroundGesture>[0]> = {}) => ({
  button: 0,
  ctrlKey: false,
  spaceHeld: false,
  shiftKey: false,
  marqueeMode: false,
  ...over,
})

describe('空白处手势裁决', () => {
  it('普通左键 = 平移（用户裁决：画布要能直接拖）', () => {
    expect(backgroundGesture(mods())).toBe('pan')
  })

  // 触摸指针的修饰键组合：触屏没有修饰键、PointerEvent.button 恒为 0。
  // 它恰好命中 backgroundGesture 的默认分支 ⇒「单指拖空白 = 平移」在触摸下**已经成立**，
  // 故画布触屏适配**不给 PointerModifiers 加 pointerType**（加了不改变任何行为，属 YAGNI）。
  // 本用例与上面那条 mods() 的默认组合数值上相同，但**语义不同**：它把「触摸」这个设备类型
  // 显式钉在这里 —— 将来有人给 gesture.ts 加鼠标专属分支、把触摸挤到 'none' 时，
  // 这一条会连同注释一起指出「触摸的契约被改了」。
  it('触摸（button 0 + 无修饰键）→ pan', () => {
    expect(
      backgroundGesture({ button: 0, ctrlKey: false, spaceHeld: false, shiftKey: false, marqueeMode: false }),
    ).toBe('pan')
  })

  it('Shift + 左键 = 框选（默认对调后框选仍有入口）', () => {
    expect(backgroundGesture(mods({ shiftKey: true }))).toBe('marquee')
  })

  it('中键 = 平移（上游口径，保留）', () => {
    expect(backgroundGesture(mods({ button: 1 }))).toBe('pan')
    expect(backgroundGesture(mods({ button: 1, shiftKey: true }))).toBe('pan')
  })

  it('空格 / Ctrl + 左键 = 平移（上游口径，保留）', () => {
    expect(backgroundGesture(mods({ spaceHeld: true }))).toBe('pan')
    expect(backgroundGesture(mods({ ctrlKey: true }))).toBe('pan')
    // 与 Shift 同时按下时，平移优先（Ctrl/空格的语义更强）
    expect(backgroundGesture(mods({ spaceHeld: true, shiftKey: true }))).toBe('pan')
    expect(backgroundGesture(mods({ ctrlKey: true, shiftKey: true }))).toBe('pan')
  })

  it('右键等一律不接管', () => {
    expect(backgroundGesture(mods({ button: 2 }))).toBe('none')
    expect(backgroundGesture(mods({ button: 2, ctrlKey: true, spaceHeld: true }))).toBe('none')
    expect(backgroundGesture(mods({ button: 3 }))).toBe('none')
  })

  it('平移与框选互斥：任一次按下只会得到一种手势', () => {
    const combos = [
      mods(),
      mods({ shiftKey: true }),
      mods({ ctrlKey: true }),
      mods({ spaceHeld: true }),
      mods({ button: 1 }),
    ]
    for (const c of combos) {
      expect(['pan', 'marquee']).toContain(backgroundGesture(c))
    }
  })

  it('左键的两种手势各有唯一触发组合（不会两种都拿不到）', () => {
    expect(backgroundGesture(mods())).toBe('pan')
    expect(backgroundGesture(mods({ shiftKey: true }))).toBe('marquee')
  })
})

describe('框选模式开关（触屏上 Shift 的等价物）', () => {
  it('开着时：左键拖空白 = 框选', () => {
    expect(backgroundGesture(mods({ marqueeMode: true }))).toBe('marquee')
  })

  it('修饰键语义更强：Ctrl / 空格 / 中键仍为平移', () => {
    expect(backgroundGesture(mods({ marqueeMode: true, ctrlKey: true }))).toBe('pan')
    expect(backgroundGesture(mods({ marqueeMode: true, spaceHeld: true }))).toBe('pan')
    expect(backgroundGesture(mods({ marqueeMode: true, button: 1 }))).toBe('pan')
  })

  it('非左键仍不接管', () => {
    expect(backgroundGesture(mods({ marqueeMode: true, button: 2 }))).toBe('none')
  })

  it('与 Shift 同时为真不产生双重效果（等价而非叠加）', () => {
    expect(backgroundGesture(mods({ marqueeMode: true, shiftKey: true }))).toBe('marquee')
  })

  it('关着时既有行为逐条不变（回归）', () => {
    expect(backgroundGesture(mods())).toBe('pan')
    expect(backgroundGesture(mods({ shiftKey: true }))).toBe('marquee')
    expect(backgroundGesture(mods({ marqueeMode: false, shiftKey: true }))).toBe('marquee')
  })
})
