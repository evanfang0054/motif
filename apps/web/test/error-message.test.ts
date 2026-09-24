import { describe, expect, it } from 'vitest'
import { errorMessage } from '@/lib/error-message'
import { ApiError } from '@/lib/client'

/**
 * `errorMessage` 的用例（issue #100）。
 *
 * 这里要钉住的是一条**容易「形式改了、语义没达成」**的边界：
 * 收口英文原文时，很容易顺手把判据写成「只认 ApiError」，但那会把本仓**故意抛出的中文 `Error`**
 * （画布归档解析、参考图上限、裸 fetch 手写解析…）也一起换成泛化兜底 —— 用户反而看不到具体原因。
 * 所以下面两组用例缺一不可：**中文必须原样透传**（含非 ApiError），**英文必须被挡**。
 */
describe('errorMessage：把任意抛出物转成中文可展示文案', () => {
  it('ApiError 的中文原因原样透传（服务端 ServiceError 的具体原因不能丢）', () => {
    expect(errorMessage(new ApiError(400, '邮箱或密码不正确。'), '登录失败')).toBe('邮箱或密码不正确。')
  })

  it('普通 Error 的中文原因也透传 —— 画布归档 / 导出取图 / 参考图上限抛的就是这种', () => {
    expect(errorMessage(new Error('导入失败：不是画布归档（缺少 canvas.json）。'), '导入失败。')).toBe(
      '导入失败：不是画布归档（缺少 canvas.json）。'
    )
    expect(errorMessage(new Error('导出失败：有图片取不到（HTTP 404）。'), '导出失败。')).toBe(
      '导出失败：有图片取不到（HTTP 404）。'
    )
    expect(errorMessage(new Error('参考图最多 5 张，请先移除一张再添加'), '加入参考图失败')).toBe(
      '参考图最多 5 张，请先移除一张再添加'
    )
  })

  it('浏览器英文原文（离线时 fetch reject 的那几个）换成中文兜底', () => {
    const failed = errorMessage(new TypeError('Failed to fetch'), '支付失败')
    expect(failed).toBe('支付失败')
    expect(failed).not.toContain('Failed to fetch')
    // Safari 的原文是 `Load failed`
    expect(errorMessage(new TypeError('Load failed'), '支付失败')).toBe('支付失败')
    expect(errorMessage(new Error('NetworkError when attempting to fetch resource.'), '保存失败')).toBe('保存失败')
  })

  it('ApiError 但文案是框架英文（Unauthorized / Forbidden）时同样不透传', () => {
    expect(errorMessage(new ApiError(401, 'Unauthorized'), '操作失败')).toBe('操作失败')
    expect(errorMessage(new ApiError(403, 'Forbidden'), '操作失败')).toBe('操作失败')
  })

  it('ApiError 的空文案按「无中文」处理，回落兜底（不显示空白）', () => {
    expect(errorMessage(new ApiError(500, ''), '请求失败')).toBe('请求失败')
  })

  it('非 Error 的未知抛出（字符串 / null / undefined / 对象）一律回落兜底，不出现 [object Object]', () => {
    expect(errorMessage('boom', '操作失败')).toBe('操作失败')
    expect(errorMessage(null, '操作失败')).toBe('操作失败')
    expect(errorMessage(undefined, '操作失败')).toBe('操作失败')
    expect(errorMessage({ message: 'x' }, '操作失败')).toBe('操作失败')
  })

  it('兜底文案原样返回（调用方按场景给的那句必须生效）', () => {
    expect(errorMessage(new TypeError('Failed to fetch'), '网络开小差了，请稍后重试。')).toBe('网络开小差了，请稍后重试。')
  })
})
