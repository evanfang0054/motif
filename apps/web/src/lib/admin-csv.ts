/**
 * CDK 导出内容（纯函数，便于单测）。
 * 抽出来的原因：CSV 下载在 CDP 接管的浏览器里默认被禁止 —— 端到端测试「点了没反应也不报错」，
 * 是典型的假通过。所以内容生成单独可测，端到端只验证按钮存在且点击不抛异常。
 */
export interface CdkCsvRow {
  code: string
  credits: number
  status: string
  redeemedBy: string | null
  redeemedAt: string | null
  revokedAt: string | null
  createdAt: string
}

/** 字段含逗号/引号/换行时按 CSV 规范加引号并转义内部引号 */
function cell(v: string | number | null): string {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function buildCdkCsv(rows: CdkCsvRow[]): string {
  const head = ['code', 'credits', 'status', 'redeemed_by', 'redeemed_at', 'revoked_at', 'created_at']
  const body = rows.map((r) =>
    [r.code, r.credits, r.status, r.redeemedBy, r.redeemedAt, r.revokedAt, r.createdAt].map(cell).join(',')
  )
  return `${head.join(',')}\n${body.join('\n')}\n`
}
