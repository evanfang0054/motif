'use client'

import { useCallback, useEffect, useState } from 'react'
import { api, type AdminAuditRow } from '@/lib/client'
import { ListCount, ListEmptyRow, ListLoadingRow, Pager } from '@/components/admin/ListUi'

const PAGE_SIZE = 20

export default function AdminAuditPage() {
  const [items, setItems] = useState<AdminAuditRow[]>([])
  const [total, setTotal] = useState(0)
  const [actorId, setActorId] = useState('')
  const [action, setAction] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await api.adminListAudit({ actorId: actorId || undefined, action: action || undefined, page, pageSize: PAGE_SIZE })
      setItems(r.items)
      setTotal(r.total)
      setErr(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [actorId, action, page])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <section className="admin-panel">
      <h1 className="admin-title">审计日志</h1>
      <p className="admin-muted">所有会改变他人或系统状态的管理动作都在这里留痕，用于回答「谁对谁做了什么」。</p>

      <div className="admin-toolbar">
        <input type="search" value={actorId} onChange={(e) => { setActorId(e.target.value); setPage(1) }} placeholder="按操作者 ID 筛选" />
        <input type="search" value={action} onChange={(e) => { setAction(e.target.value); setPage(1) }} placeholder="按动作精确筛选，如 credit.adjust" />
        <ListCount loading={loading} total={total} unit="条" />
      </div>

      {err && <div className="admin-alert-err" role="alert">{err}</div>}

      <table className="admin-table">
        <thead>
          <tr>
            <th>时间</th><th>操作者</th><th>动作</th><th>目标</th><th>详情</th>
          </tr>
        </thead>
        <tbody>
          {items.map((r) => (
            <tr key={r.id}>
              <td data-label="时间">{r.createdAt.slice(0, 19).replace('T', ' ')}</td>
              <td className="admin-mono" data-label="操作者">{r.actorId}</td>
              <td className="admin-mono" data-label="动作">{r.action}</td>
              <td className="admin-mono" data-label="目标">{r.targetType ? `${r.targetType}:${r.targetId ?? '—'}` : '—'}</td>
              {/* detail 是 JSON 字符串，原样展示不美化 —— 它可能很长，折叠起来 */}
              <td data-label="详情">
                {r.detail ? <details><summary>展开</summary><pre className="admin-detail">{r.detail}</pre></details> : '—'}
              </td>
            </tr>
          ))}
          {loading ? (
            <ListLoadingRow colSpan={5} />
          ) : (
            items.length === 0 && <ListEmptyRow colSpan={5} text="（无匹配的审计记录）" />
          )}
        </tbody>
      </table>

      <Pager page={page} pageSize={PAGE_SIZE} total={total} onChange={setPage} />
    </section>
  )
}
