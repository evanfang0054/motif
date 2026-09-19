import { createHash, timingSafeEqual } from 'node:crypto'

export interface EpayConfig {
  apiUrl: string
  pid: string
  key: string
}

/**
 * 易支付签名（逐行移植 go-epay epay/util.go，new-api 同款依赖）：
 * 过滤 sign/sign_type/空值 → 键 ASCII 升序 → k=v& 拼接去尾 & → 拼 key → MD5 hex 小写。
 * MD5 为协议规范限定；「尾拼 key」构造不存在长度扩展攻击（那要求密钥在前缀）。
 */
export function epaySign(params: Record<string, string>, key: string): string {
  const filtered = Object.entries(params).filter(([k, v]) => k !== 'sign' && k !== 'sign_type' && v !== '')
  filtered.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const url = filtered.map(([k, v]) => `${k}=${v}`).join('&')
  return createHash('md5').update(url + key).digest('hex')
}

/** 下单：生成网关收银页跳转地址（GET /submit.php，参数含签名；先对原始值签名、再整体编码，与 go-epay 顺序一致） */
export function buildEpayPurchaseUrl(
  cfg: EpayConfig,
  args: {
    type: string
    outTradeNo: string
    name: string
    money: string
    notifyUrl: string
    returnUrl: string
  }
): string {
  const params: Record<string, string> = {
    pid: cfg.pid,
    type: args.type, // 默认 alipay；网关收银页通常允许用户在页内切换微信/支付宝
    out_trade_no: args.outTradeNo,
    notify_url: args.notifyUrl,
    return_url: args.returnUrl,
    name: args.name,
    money: args.money, // 元，两位小数（协议金额单位是元）
    device: 'pc',
  }
  params.sign = epaySign(params, cfg.key)
  params.sign_type = 'MD5'
  const base = new URL(cfg.apiUrl)
  base.pathname = `${base.pathname.replace(/\/+$/, '')}/submit.php`
  return `${base.origin}${base.pathname}?${new URLSearchParams(params).toString()}`
}

/**
 * 回调验签：重算签名与传入 sign 恒定时间比对（等长校验 + timingSafeEqual，严格大小写——与 go-epay Verify 一致，网关按协议发小写 hex）。
 * 成功后调用方还须校验 trade_status === 'TRADE_SUCCESS' 与金额一致。
 */
export function verifyEpayNotify(params: Record<string, string>, key: string): { ok: boolean } {
  const sign = params['sign']
  if (!sign) return { ok: false }
  const a = Buffer.from(epaySign(params, key), 'utf8')
  const b = Buffer.from(sign, 'utf8')
  if (a.length !== b.length) return { ok: false }
  return { ok: timingSafeEqual(a, b) }
}
