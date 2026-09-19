import { describe, expect, it } from 'vitest'
import { epaySign, buildEpayPurchaseUrl, verifyEpayNotify } from '@/server/payment/epay'

describe('epaySign（与 go-epay 交叉验证）', () => {
  it('权威向量：device/devicev&money/moneyv + key 1234567', () => {
    expect(epaySign({ device: 'devicev', money: 'moneyv' }, '1234567')).toBe('3854cc9f022e0fb821bd2e002260245d')
  })
  it('过滤 sign/sign_type/空值后按 ASCII 升序签名', () => {
    const a = epaySign({ pid: '1', type: 'wxpay', sign: 'x', sign_type: 'MD5', name: '' }, 'k')
    const b = epaySign({ pid: '1', type: 'wxpay' }, 'k')
    expect(a).toBe(b)
  })
})

describe('buildEpayPurchaseUrl', () => {
  const cfg = { apiUrl: 'https://pay.example.com/', pid: '1001', key: 'testkey' }
  it('落在网关 /submit.php，带全参数且 sign 可复算', () => {
    const url = buildEpayPurchaseUrl(cfg, {
      type: 'alipay', outTradeNo: 'ord_1', name: '50 张额度', money: '68.00',
      notifyUrl: 'https://m.example.com/api/billing/notify/epay', returnUrl: 'https://m.example.com/billing/result?order=ord_1',
    })
    const u = new URL(url)
    expect(u.origin + u.pathname).toBe('https://pay.example.com/submit.php')
    expect(u.searchParams.get('pid')).toBe('1001')
    expect(u.searchParams.get('sign_type')).toBe('MD5')
    const params = Object.fromEntries(u.searchParams)
    expect(params.sign).toBe(epaySign(params, 'testkey'))
  })
  it('网关地址多尾斜杠不会产出 //submit.php', () => {
    const url = buildEpayPurchaseUrl({ ...cfg, apiUrl: 'https://p.example.com//' }, {
      type: 'alipay', outTradeNo: 'o', name: 'n', money: '1.00', notifyUrl: 'https://a/n', returnUrl: 'https://a/r',
    })
    expect(new URL(url).pathname).toBe('/submit.php')
  })
})

describe('verifyEpayNotify', () => {
  const params = { pid: '1001', trade_no: 'G2024', out_trade_no: 'ord_1', type: 'alipay', name: '50 张额度', money: '68.00', trade_status: 'TRADE_SUCCESS' }
  it('正确签名通过；缺 sign / 篡改 money / 错 key / 大写伪装 拒绝', () => {
    const signed = { ...params, sign: epaySign(params, 'testkey'), sign_type: 'MD5' }
    expect(verifyEpayNotify(signed, 'testkey').ok).toBe(true)
    expect(verifyEpayNotify({ ...signed, money: '0.01' }, 'testkey').ok).toBe(false)
    expect(verifyEpayNotify({ ...params, sign_type: 'MD5' }, 'testkey').ok).toBe(false)
    expect(verifyEpayNotify(signed, 'wrongkey').ok).toBe(false)
    expect(verifyEpayNotify({ ...signed, sign: signed.sign.toUpperCase() }, 'testkey').ok).toBe(false) // 签名按小写严格比对
  })
})
