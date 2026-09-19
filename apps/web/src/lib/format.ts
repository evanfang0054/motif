/**
 * 时间展示统一入口。
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
