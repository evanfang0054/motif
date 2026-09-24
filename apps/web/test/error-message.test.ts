import { describe, expect, it } from 'vitest'
import { errorMessage, hasChinese, isNetworkFailureReason, zhReason } from '@/lib/error-message'
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
    // 原先这里紧跟一条 `expect(failed).not.toContain('Failed to fetch')` —— 它在 `toBe('支付失败')`
    // 之后恒真（'支付失败' 本就不含那串英文），没有区分力，已换成下面这对**互为对照**的边界断言。
    // Safari 的原文是 `Load failed`
    expect(errorMessage(new TypeError('Load failed'), '支付失败')).toBe('支付失败')
    expect(errorMessage(new Error('NetworkError when attempting to fetch resource.'), '保存失败')).toBe('保存失败')
  })

  it('中英混排按「含中文即透传」放行（英文尾巴是已知边界，非回归）；纯英文仍被挡', () => {
    // 判据只看「有没有 CJK」，故中文前缀 + 英文尾巴会整句带出（见 error-message.ts 的边界说明）。
    // 这条与下一条互为对照：只改「是否含中文」就会让其中一条先红，才真正钉住判据。
    // ⚠️ 本用例钉的是 errorMessage 的**通用判据**，不是说服务端还会产出这个串 —— #106 已把三条
    // 「拼出来的 reason 串」在源头收口（走 zhReason），下面 describe('zhReason…') 钉的是那条路径。
    expect(errorMessage(new Error('示例图抓取失败：fetch failed'), '加入参考图失败')).toBe('示例图抓取失败：fetch failed')
    expect(errorMessage(new Error('fetch failed'), '加入参考图失败')).toBe('加入参考图失败')
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

/**
 * `zhReason` / `isNetworkFailureReason` 的用例（issue #106）。
 *
 * 钉住的是一条**和 `errorMessage` 不同机制**的泄漏口：服务端把底层异常的 `message` 拼进一个
 * 已经是中文的句子（`示例图抓取失败：fetch failed`），必然含中文、必然骗过 `errorMessage` 的判据。
 * 下面两组缺一不可：**中文必须原样透传**（不能把「抓取超时」这种已有中文的原因也换成兜底），
 * **纯英文必须被收口**（含网络层要给可行动的那句，而不是泛化兜底）。
 */
describe('zhReason：服务端 reason 串的中文收口（#106）', () => {
  it('中文原因原样透传 —— describeReason 已经翻译好的那几种不能被再兜底一次', () => {
    expect(zhReason('抓取超时', '抓取失败')).toBe('抓取超时')
    expect(zhReason('返回的不是合法 JSON', '抓取失败')).toBe('返回的不是合法 JSON')
    expect(zhReason('未返回任何条目', '抓取失败')).toBe('未返回任何条目')
  })

  it('网络层英文给可行动的中文（比调用方的泛化兜底更有信息量）', () => {
    expect(zhReason('fetch failed', '抓取失败')).toBe('网络不可达')
    expect(zhReason('connect ECONNREFUSED 127.0.0.1:443', '抓取失败')).toBe('网络不可达')
    expect(zhReason('getaddrinfo ENOTFOUND example.com', '抓取失败')).toBe('网络不可达')
  })

  it('其余纯英文回落调用方兜底（原始原因仍在日志 / 管理端，不在用户眼前）', () => {
    expect(zhReason('Input buffer contains unsupported image format', '抓取失败')).toBe('抓取失败')
    expect(zhReason('', '抓取失败')).toBe('抓取失败')
  })

  it('中英混排但**不是**网络失败时原样透传 —— 收口只认「有没有中文」与网络特征，不做「猜哪段是英文」', () => {
    expect(zhReason('生成图片内容类型异常：text/html', '抓取失败')).toBe('生成图片内容类型异常：text/html')
  })

  it('isNetworkFailureReason 只认网络特征，别把普通英文当网络故障', () => {
    expect(isNetworkFailureReason('fetch failed')).toBe(true)
    expect(isNetworkFailureReason('socket hang up')).toBe(true)
    expect(isNetworkFailureReason('Input buffer contains unsupported image format')).toBe(false)
    expect(isNetworkFailureReason('抓取超时')).toBe(false)
  })

  it('hasChinese 的判据边界：CJK 才算，拉丁字母 / 数字 / 标点都不算', () => {
    expect(hasChinese('失败')).toBe(true)
    expect(hasChinese('HTTP 502')).toBe(false)
    expect(hasChinese('429')).toBe(false)
    expect(hasChinese('')).toBe(false)
  })
})
