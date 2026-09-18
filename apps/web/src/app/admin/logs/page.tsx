'use client'

import { useCallback, useEffect, useState } from 'react'
import { api, type AdminLogRow } from '@/lib/client'

const STATUS_LABEL: Record<string, string> = {
  queued: '排队中',
  running: '生成中',
  canceling: '取消中',
  completed: '已完成',
  failed: '失败',
  canceled: '已取消',
}

const DAYS_DEFAULT = 90

export default function AdminLogsPage() {
  const [items, setItems] = useState<AdminLogRow[]>([])
  const [total, setTotal] = useState(0)
  const [status, setStatus] = useState('')
  const [userId, setUserId] = useState('')
  const [days, setDays] = useState(String(DAYS_DEFAULT))
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await api.adminListLogs({ status: status || undefined, userId: userId || undefined, pageSize: 100 })
      setItems(r.items)
      setTotal(r.total)
      setErr(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : '加载失败')
    }
  }, [status, userId])

  useEffect(() => {
    void load()
  }, [load])

  async function cleanup() {
    const n = Number(days)
    if (!Number.isInteger(n) || n < 1 || n > 3650) return setErr('保留天数需为 1–3650 的整数。')
    if (
      !window.confirm(
        `确认清理 ${n} 天前的历史生成记录？\n\n这些记录是额度对账的唯一追溯依据，删除后无法恢复。\n只删除已结束（完成 / 失败 / 已取消）的轮次，不会删除画布图片与额度流水。`
      )
    )
      return
    setBusy(true)
    setErr(null)
    try {
      const r = await api.adminCleanupLogs(n)
      setMsg(`已清理 ${r.deleted} 条（阈值 ${r.before.slice(0, 19).replace('T', ' ')} 之前）`)
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : '清理失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="admin-panel">
      <h1 className="admin-title">生成日志</h1>
      <p className="admin-muted">全站生成轮次视图（跨用户）。用于回答「这次生成为什么失败」。</p>

      <div className="admin-toolbar">
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">全部状态</option>
          {Object.entries(STATUS_LABEL).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
        <input type="search" value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="按用户 ID 筛选" />
        <span className="admin-muted">共 {total} 条</span>
        <span style={{ flex: 1 }} />
        <input
          type="number"
          min={1}
          max={3650}
          value={days}
          onChange={(e) => setDays(e.target.value)}
          style={{ width: 90 }}
          aria-label="清理保留天数"
        />
        <button className="admin-btn-danger" disabled={busy} onClick={() => void cleanup()}>
          清理 {days} 天前
        </button>
      </div>

      {msg && <div className="admin-alert-ok" role="status">{msg}</div>}
      {err && <div className="admin-alert-err" role="alert">{err}</div>}

      <table className="admin-table">
        <thead>
          <tr>
            <th>时间</th><th>用户</th><th>状态</th><th>张数</th><th>重试</th><th>失败原因</th><th>提示词</th>
          </tr>
        </thead>
        <tbody>
          {items.map((m) => (
            <tr key={m.id}>
              <td data-label="时间">{m.createdAt.slice(0, 19).replace('T', ' ')}</td>
              <td className="admin-mono" data-label="用户">{m.userId}</td>
              <td data-label="状态">
                <span className="admin-chip">{STATUS_LABEL[m.status] ?? m.status}</span>
              </td>
              <td data-label="张数">{m.generatedCount}/{m.requestedCount}</td>
              <td data-label="重试">{m.attempts}</td>
              <td data-label="失败原因">{m.error ? <span className="admin-mono">{m.error}</span> : '—'}</td>
              <td data-label="提示词">
                <details>
                  <summary>展开</summary>
                  <div className="admin-prompt">
                    <div><b>用户提交</b>：{m.prompt}</div>
                    <div><b>实际发往网关</b>：{m.finalPrompt}</div>
                  </div>
                </details>
              </td>
            </tr>
          ))}
          {items.length === 0 && (
            <tr><td colSpan={7} className="admin-muted">（无匹配的生成记录）</td></tr>
          )}
        </tbody>
      </table>
    </section>
  )
}
