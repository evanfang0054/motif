import { describe, expect, it } from 'vitest'
import { backgroundGesture } from '@/lib/canvas/gesture'

describe('空白处手势裁决（照抄上游 infinite-canvas.tsx:114-135）', () => {
  it('普通左键 = 框选（保住既有 CanvasBoard 的框选语义）', () => {
    expect(backgroundGesture({ button: 0, ctrlKey: false, spaceHeld: false })).toBe('marquee')
  })

  it('中键 = 平移', () => {
    expect(backgroundGesture({ button: 1, ctrlKey: false, spaceHeld: false })).toBe('pan')
  })

  it('空格 + 左键 = 平移', () => {
    expect(backgroundGesture({ button: 0, ctrlKey: false, spaceHeld: true })).toBe('pan')
  })

  it('Ctrl + 左键 = 平移', () => {
    expect(backgroundGesture({ button: 0, ctrlKey: true, spaceHeld: false })).toBe('pan')
  })

  it('右键等一律不接管', () => {
    expect(backgroundGesture({ button: 2, ctrlKey: false, spaceHeld: false })).toBe('none')
    expect(backgroundGesture({ button: 2, ctrlKey: true, spaceHeld: true })).toBe('none')
    expect(backgroundGesture({ button: 3, ctrlKey: false, spaceHeld: false })).toBe('none')
  })

  it('平移与框选互斥：任一次按下只会得到一种手势', () => {
    const combos = [
      { button: 0, ctrlKey: false, spaceHeld: false },
      { button: 0, ctrlKey: true, spaceHeld: false },
      { button: 0, ctrlKey: false, spaceHeld: true },
      { button: 1, ctrlKey: false, spaceHeld: false },
    ]
    for (const c of combos) {
      expect(['pan', 'marquee']).toContain(backgroundGesture(c))
    }
  })
})
