'use client'

import { useCallback, useEffect, useState } from 'react'
import { api, type AdminFeedbackRow } from '@/lib/client'

type StatusFilter = '' | 'pending' | 'resolved'

export default function AdminFeedbackPage() {
  const [items, setItems] = useState<AdminFeedbackRow[]>([])
  const [total, setTotal] = useState(0)
  const [status, setStatus] = useState<StatusFilter>('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await api.adminListFeedback({ status: status || undefined, pageSize: 100 })
      setItems(r.items)
      setTotal(r.total)
      setErr(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : '加载失败')
    }
  }, [status])

  useEffect(() => {
    void load()
  }, [load])

  async function resolve(id: number) {
    if (!window.confirm('确认把这条反馈标记为已处理？标记后不可撤销。')) return
    setBusy(true)
    setErr(null)
    try {
      await api.adminResolveFeedback(id)
      setMsg('已标记为已处理')
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : '处理失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="admin-panel">
      <h1 className="admin-title">反馈</h1>

      <div className="admin-toolbar">
        <select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
          <option value="">全部状态</option>
          <option value="pending">待处理</option>
          <option value="resolved">已处理</option>
        </select>
        <span className="admin-muted">共 {total} 条</span>
      </div>

      {msg && <div className="admin-alert-ok" role="status">{msg}</div>}
      {err && <div className="admin-alert-err" role="alert">{err}</div>}

      <table className="admin-table">
        <thead>
          <tr>
            <th>内容</th><th>提交用户</th><th>状态</th><th>处理人</th><th>提交时间</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          {items.map((f) => (
            <tr key={f.id}>
              <td data-label="内容">{f.content}</td>
              <td className="admin-mono" data-label="提交用户">{f.userId}</td>
              <td data-label="状态">
                <span className={`admin-chip ${f.status === 'pending' ? 'is-unredeemed' : 'is-redeemed'}`}>
                  {f.status === 'pending' ? '待处理' : '已处理'}
                </span>
              </td>
              <td className="admin-mono" data-label="处理人">{f.resolvedBy ?? '—'}</td>
              <td data-label="提交时间">{f.createdAt.slice(0, 19).replace('T', ' ')}</td>
              <td data-label="操作">
                {f.status === 'pending' ? (
                  <button className="admin-btn-primary" disabled={busy} onClick={() => void resolve(f.id)}>标记已处理</button>
                ) : (
                  <span className="admin-muted">—</span>
                )}
              </td>
            </tr>
          ))}
          {items.length === 0 && (
            <tr><td colSpan={6} className="admin-muted">（无匹配的反馈）</td></tr>
          )}
        </tbody>
      </table>
    </section>
  )
}
