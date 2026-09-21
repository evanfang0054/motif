import { describe, expect, it } from 'vitest'
import { planRegenerateFromImage, stripAutoReferenceSentences } from '@/lib/canvas/regenerate'

describe('stripAutoReferenceSentences 只剥机器追加的参考句', () => {
  it('剥掉单条并收敛空白', () => {
    expect(stripAutoReferenceSentences('画一只猫 #001 作为参考图保持主体一致。')).toBe('画一只猫')
  })

  it('剥掉多条（不同编号）', () => {
    expect(
      stripAutoReferenceSentences('#001 作为参考图保持主体一致。 一只猫 #002 作为参考图保持主体一致。')
    ).toBe('一只猫')
  })

  it('句中夹带也剥，且不留下双空格', () => {
    expect(stripAutoReferenceSentences('主体一致 #003 作为参考图保持主体一致。 光线自然')).toBe('主体一致 光线自然')
  })

  it('首尾空白与换行一并收敛', () => {
    expect(stripAutoReferenceSentences('\n  一只猫  \n')).toBe('一只猫')
  })

  it('用户手写的相近文字不动（位数不符）', () => {
    expect(stripAutoReferenceSentences('画一只猫 #12 作为参考图保持主体一致。')).toBe(
      '画一只猫 #12 作为参考图保持主体一致。'
    )
  })

  it('用户手写的相近文字不动（后半句不同）', () => {
    expect(stripAutoReferenceSentences('画一只猫 #003 参考一下')).toBe('画一只猫 #003 参考一下')
  })

  it('序号到四位（padStart 只保证至少三位）也能剥掉', () => {
    expect(stripAutoReferenceSentences('#1234 作为参考图保持主体一致。 一只猫')).toBe('一只猫')
  })

  it('空串不炸', () => {
    expect(stripAutoReferenceSentences('')).toBe('')
  })
})

describe('planRegenerateFromImage', () => {
  const image = { id: 'cimg_9', serial: 3, messageId: 'msg_1' }

  it('正常路径：提示词换成该轮原始提示词并重挂本图编号，画布引用替换为本图', () => {
    const plan = planRegenerateFromImage({
      image,
      messages: [{ id: 'msg_1', prompt: '画一只猫 #001 作为参考图保持主体一致。' }],
      currentPrompt: '面板里手敲的另一段提示词',
      stagedIds: [],
      maxReferences: 5,
    })
    expect(plan).toEqual({
      ok: true,
      prompt: '画一只猫 #003 作为参考图保持主体一致。',
      referenceIds: ['cimg_9'],
      reusedPrompt: true,
    })
  })

  it('暂存参考保留，且排在前面（提交时会被一起带上）', () => {
    const plan = planRegenerateFromImage({
      image,
      messages: [{ id: 'msg_1', prompt: '画一只猫' }],
      currentPrompt: '',
      stagedIds: ['refu_1', 'refu_2'],
      maxReferences: 5,
    })
    expect(plan.ok && plan.referenceIds).toEqual(['refu_1', 'refu_2', 'cimg_9'])
  })

  it('上传图（没有轮次）：提示词一字不动', () => {
    const plan = planRegenerateFromImage({
      image: { id: 'cimg_1', serial: 1, messageId: null },
      messages: [{ id: 'msg_1', prompt: '画一只猫' }],
      currentPrompt: '面板里手敲的提示词',
      stagedIds: [],
      maxReferences: 5,
    })
    expect(plan).toEqual({
      ok: true,
      prompt: '面板里手敲的提示词',
      referenceIds: ['cimg_1'],
      reusedPrompt: false,
    })
  })

  it('轮次已从记录里消失（悬空 messageId）：同样一字不动', () => {
    const plan = planRegenerateFromImage({
      image: { id: 'cimg_9', serial: 3, messageId: 'msg_gone' },
      messages: [{ id: 'msg_1', prompt: '画一只猫' }],
      currentPrompt: '手敲的',
      stagedIds: [],
      maxReferences: 5,
    })
    expect(plan.ok && plan.reusedPrompt).toBe(false)
    expect(plan.ok && plan.prompt).toBe('手敲的')
  })

  it('暂存已占满上限：整体不生效（不产出半截状态）', () => {
    const plan = planRegenerateFromImage({
      image,
      messages: [{ id: 'msg_1', prompt: '画一只猫' }],
      currentPrompt: '手敲的',
      stagedIds: ['a', 'b', 'c', 'd', 'e'],
      maxReferences: 5,
    })
    expect(plan).toEqual({ ok: false, reason: 'cap' })
  })

  it('边界：暂存 4 张 + 本图 = 恰好 5 张，合法', () => {
    const plan = planRegenerateFromImage({
      image,
      messages: [{ id: 'msg_1', prompt: '画一只猫' }],
      currentPrompt: '',
      stagedIds: ['a', 'b', 'c', 'd'],
      maxReferences: 5,
    })
    expect(plan.ok).toBe(true)
    expect(plan.ok && plan.referenceIds).toHaveLength(5)
  })

  it('messageId 为空串（不是 null）同样按「没有可复用轮次」处理', () => {
    const plan = planRegenerateFromImage({
      image: { id: 'cimg_9', serial: 3, messageId: '' },
      messages: [{ id: 'msg_1', prompt: '画一只猫' }],
      currentPrompt: '手敲的',
      stagedIds: [],
      maxReferences: 5,
    })
    expect(plan.ok && plan.reusedPrompt).toBe(false)
    expect(plan.ok && plan.prompt).toBe('手敲的')
  })

  it('原轮次提示词只有参考句时：只留本图那一句（不留空串）', () => {
    const plan = planRegenerateFromImage({
      image,
      messages: [{ id: 'msg_1', prompt: '#001 作为参考图保持主体一致。' }],
      currentPrompt: '',
      stagedIds: [],
      maxReferences: 5,
    })
    expect(plan.ok && plan.prompt).toBe('#003 作为参考图保持主体一致。')
  })
})
