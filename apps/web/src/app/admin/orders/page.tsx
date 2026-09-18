'use client'

import { useCallback, useEffect, useState } from 'react'
import { api, type AdminOrder } from '@/lib/client'
import { ListCount, ListEmptyRow, ListLoadingRow, Pager } from '@/components/admin/ListUi'

const PAGE_SIZE = 20

const STATUS_LABEL: Record<string, string> = {
  pending: '待支付',
  paid: '已支付',
}

/**
 * amountTotal 以「分」存储（868 = HK$8.68），展示时换算并保留两位小数。
 * 注意：购买页 `dialogs.tsx` 用 `.toFixed(0)`（显示「HK$ 9」），与本页的两位小数
 * 不完全一致 —— 这是本 PR 已知的呈现差异，未顺手改动购买页（属另一处改动范围）。
 */
function money(amount: number, currency: string): string {
  const code = currency.toUpperCase()
  const symbol = code === 'HKD' ? 'HK$' : `${code} `
  return `${symbol} ${(amount / 100).toFixed(2)}`
}

export default function AdminOrdersPage() {
  const [items, setItems] = useState<AdminOrder[]>([])
  const [total, setTotal] = useState(0)
  const [status, setStatus] = useState('')
  const [userId, setUserId] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await api.adminListOrders({ status: status || undefined, userId: userId || undefined, page, pageSize: PAGE_SIZE })
      setItems(r.items)
      setTotal(r.total)
      setErr(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [status, userId, page])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <section className="admin-panel">
      <h1 className="admin-title">订单</h1>
      <p className="admin-muted">
        订单为只读记录。当前唯一支付路径是模拟收银台，「已支付」不等于真实收款。
      </p>

      <div className="admin-toolbar">
        <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1) }}>
          <option value="">全部状态</option>
          <option value="pending">待支付</option>
          <option value="paid">已支付</option>
        </select>
        <input type="search" value={userId} onChange={(e) => { setUserId(e.target.value); setPage(1) }} placeholder="按用户 ID 筛选" />
        <ListCount loading={loading} total={total} unit="笔" />
      </div>

      {err && <div className="admin-alert-err" role="alert">{err}</div>}

      <table className="admin-table">
        <thead>
          <tr>
            <th>订单号</th><th>套餐</th><th>额度</th><th>金额</th><th>状态</th><th>创建时间</th><th>支付时间</th>
          </tr>
        </thead>
        <tbody>
          {items.map((o) => (
            <tr key={o.id}>
              <td className="admin-mono" data-label="订单号">{o.id}</td>
              <td data-label="套餐">{o.packageId}</td>
              <td data-label="额度">{o.credits}</td>
              <td data-label="金额">{money(o.amountTotal, o.currency)}</td>
              <td data-label="状态"><span className="admin-chip">{STATUS_LABEL[o.status] ?? o.status}</span></td>
              <td data-label="创建时间">{o.createdAt.slice(0, 19).replace('T', ' ')}</td>
              <td data-label="支付时间">{o.paidAt ? o.paidAt.slice(0, 19).replace('T', ' ') : '—'}</td>
            </tr>
          ))}
          {loading ? (
            <ListLoadingRow colSpan={7} />
          ) : (
            items.length === 0 && <ListEmptyRow colSpan={7} text="（无匹配的订单）" />
          )}
        </tbody>
      </table>

      <Pager page={page} pageSize={PAGE_SIZE} total={total} onChange={setPage} />
    </section>
  )
}
