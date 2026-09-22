/**
 * 展示层格式化统一入口：时间与金额。
 *
 * 数据库一律存 UTC ISO 串（`new Date().toISOString()`，可排序、无歧义）；
 * 展示层必须转成查看者的本地时区——此前 admin 各列表直接 `iso.slice(0, 19)` 截取，
 * 把 UTC 原样当本地时间显示，导致所有创建/支付时间差了时区偏移（如北京时间差 8 小时）。
 */
export function formatDateTime(
  iso: string | null | undefined,
  opts?: { timeZone?: string }
): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const parts = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    ...(opts?.timeZone ? { timeZone: opts.timeZone } : {}),
  }).formatToParts(d)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`
}

/**
 * 币种符号映射（不含零小数货币）；未知币种退化为 ISO 代码。
 *
 * 为什么收敛到这一处：币种是后台可配的（`BILLING_CURRENCY`），而概览页、订单页、充值弹窗
 * 曾各写一份映射，于是出现「概览写死 HK$、订单页只认 HKD、弹窗认五种」的自相矛盾。
 * 三处共用本表后，符号只可能随配置一起变。
 */
const CURRENCY_SYMBOL: Record<string, string> = { cny: '¥', usd: 'US$', hkd: 'HK$', eur: '€', gbp: '£' }

/** 金额一律以「分」存储，展示时换算为两位小数：`formatMoney(868, 'hkd')` → `HK$8.68` */
export function formatMoney(amountMinor: number, currency: string): string {
  // 币种缺失时不给符号也不留空格（`'' .toUpperCase() + ' '` 会产出前导空格，拼进
  // `join(' + ')` 就是「 8.68 + HK$9.00」这种怪串）。正常路径不可达（列 NOT NULL + enum）。
  const code = (currency ?? '').trim()
  if (!code) return (amountMinor / 100).toFixed(2)
  const symbol = CURRENCY_SYMBOL[code.toLowerCase()] ?? `${code.toUpperCase()} `
  return `${symbol}${(amountMinor / 100).toFixed(2)}`
}
