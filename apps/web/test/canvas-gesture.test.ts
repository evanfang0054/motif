import { describe, expect, it } from 'vitest'
import { backgroundGesture } from '@/lib/canvas/gesture'

const mods = (over: Partial<Parameters<typeof backgroundGesture>[0]> = {}) => ({
  button: 0,
  ctrlKey: false,
  spaceHeld: false,
  shiftKey: false,
  ...over,
})

describe('空白处手势裁决', () => {
  it('普通左键 = 平移（用户裁决：画布要能直接拖）', () => {
    expect(backgroundGesture(mods())).toBe('pan')
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
