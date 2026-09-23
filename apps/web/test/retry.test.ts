import { describe, expect, it } from 'vitest'
import { COUNT_MAX, COUNT_MIN } from '@motif/core'
import { planRetryFromMessage } from '@/lib/retry'

/** 只取 planRetryFromMessage 真正读到的字段，避免测试被无关字段噪音淹没 */
function msg(over: Partial<{ prompt: string; size: string; requestedCount: number; referenceIds: string[] }> = {}) {
  return {
    prompt: '画一只猫',
    size: '1024x1024',
    requestedCount: 4,
    referenceIds: [] as string[],
    ...over,
  }
}

describe('失败重试的表单还原（#73-1.5）', () => {
  it('预设尺寸原样回填（不会被误判成自定义）', () => {
    for (const size of ['1024x1024', '1024x1536', '1536x1024']) {
      expect(planRetryFromMessage({ message: msg({ size }), canvasImageIds: [] }).size).toBe(size)
    }
  })

  it('auto 原样回填', () => {
    const plan = planRetryFromMessage({ message: msg({ size: 'auto' }), canvasImageIds: [] })
    expect(plan.size).toBe('auto')
  })

  it('非预设的合法 WxH 落成自定义，并把宽高填进数字框', () => {
    const plan = planRetryFromMessage({ message: msg({ size: '800x600' }), canvasImageIds: [] })
    expect(plan.size).toBe('custom')
    expect(plan.customW).toBe(800)
    expect(plan.customH).toBe(600)
  })

  it('非自定义时宽高回落到默认值（不把上一轮的残留带进数字框）', () => {
    const plan = planRetryFromMessage({ message: msg({ size: 'auto' }), canvasImageIds: [] })
    expect(plan.customW).toBe(1024)
    expect(plan.customH).toBe(1024)
  })

  it('尺寸过不了服务端同一判据时回退 auto（绝不把服务端会拒的形状喂回去）', () => {
    // 这些全是 `validateSize`（= 服务端判据）会拒的形状：格式不符 / 越界 / 非整数
    for (const size of ['', 'abc', '800x', 'x600', '0x0', '-800x600', '800x600x999', '99999x1', '800.6x600.4']) {
      const plan = planRetryFromMessage({ message: msg({ size }), canvasImageIds: [] })
      expect(plan.size, size).toBe('auto')
    }
  })

  it('张数按核心库的 clampCount 归一（0 / 超上限 / 非整数都拉回合法区间）', () => {
    const clamp = (n: number) =>
      planRetryFromMessage({ message: msg({ requestedCount: n }), canvasImageIds: [] }).count
    expect(clamp(0)).toBe(COUNT_MIN)
    expect(clamp(-3)).toBe(COUNT_MIN)
    expect(clamp(99)).toBe(COUNT_MAX)
    expect(clamp(3.4)).toBe(3)
    expect(clamp(Number.NaN)).toBe(COUNT_MIN)
  })

  it('提示词用原始 prompt 而不是 finalPrompt（否则会把上一轮的增强结果当原文再增强一遍）', () => {
    const plan = planRetryFromMessage({ message: msg({ prompt: '原始提示词' }), canvasImageIds: [] })
    expect(plan.prompt).toBe('原始提示词')
  })

  it('参考图按当前画布图过滤：已删掉的 id 必须摘掉（残留会让提交直接 400）', () => {
    const plan = planRetryFromMessage({
      message: msg({ referenceIds: ['cimg_1', 'cimg_gone', 'cimg_2'] }),
      canvasImageIds: ['cimg_1', 'cimg_2', 'cimg_3'],
    })
    expect(plan.referenceIds).toEqual(['cimg_1', 'cimg_2'])
  })

  it('画布图全被删光时参考图为空（重试仍可用，只是不带参考）', () => {
    const plan = planRetryFromMessage({
      message: msg({ referenceIds: ['cimg_1'] }),
      canvasImageIds: [],
    })
    expect(plan.referenceIds).toEqual([])
  })
})
