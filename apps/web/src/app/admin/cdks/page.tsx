'use client'

import { useCallback, useEffect, useState } from 'react'
import { api, type AdminCdk } from '@/lib/client'
import { buildCdkCsv } from '@/lib/admin-csv'
import { ListCount, ListEmptyRow, ListLoadingRow, Pager } from '@/components/admin/ListUi'

type StatusFilter = '' | 'unredeemed' | 'redeemed' | 'revoked'

const PAGE_SIZE = 20

const STATUS_LABEL: Record<Exclude<StatusFilter, ''>, string> = {
  unredeemed: '未兑换',
  redeemed: '已兑换',
  revoked: '已作废',
}

function statusOf(c: AdminCdk): Exclude<StatusFilter, ''> {
  if (c.revokedAt) return 'revoked'
  if (c.redeemedBy) return 'redeemed'
  return 'unredeemed'
}

export default function AdminCdksPage() {
  const [items, setItems] = useState<AdminCdk[]>([])
  const [total, setTotal] = useState(0)
  const [status, setStatus] = useState<StatusFilter>('')
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)

  // 批量生成表单
  const [count, setCount] = useState(10)
  const [credits, setCredits] = useState(10)
  const [prefix, setPrefix] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await api.adminListCdks({ status: status || undefined, q: q || undefined, page, pageSize: PAGE_SIZE })
      setItems(r.items)
      setTotal(r.total)
      setErr(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [status, q, page])

  useEffect(() => {
    void load()
  }, [load])

  async function generate() {
    setBusy(true)
    setErr(null)
    setMsg(null)
    try {
      const r = await api.adminCreateCdks({ count, credits, prefix: prefix || undefined })
      setMsg(`已生成 ${r.codes.length} 个码（每个 ${r.credits} 张额度）`)
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : '生成失败')
    } finally {
      setBusy(false)
    }
  }

  async function revoke(code: string) {
    if (!window.confirm(`确认作废 ${code}？作废后不可兑换，且不可撤销。`)) return
    try {
      await api.adminRevokeCdk(code)
      setMsg(`已作废 ${code}`)
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : '作废失败')
    }
  }

  async function copyCodes() {
    const text = items.map((i) => i.code).join('\n')
    try {
      await navigator.clipboard.writeText(text)
      setMsg(`已复制当前列表的 ${items.length} 个码`)
    } catch {
      setErr('浏览器拒绝了剪贴板访问，请改用导出 CSV')
    }
  }

  function exportCsv() {
    // AdminCdk 没有 status 字段（状态由 redeemedBy / revokedAt 推导），故在映射时补上中文标签
    const csv = buildCdkCsv(items.map((c) => ({ ...c, status: STATUS_LABEL[statusOf(c)] })))
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `motif-cdks-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    // 延后回收：同步 revoke 有可能在下载开始读取前就把 blob URL 撤销，导致下载中断
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <section className="admin-panel">
      <h1 className="admin-title">CDK 管理</h1>

      <div className="admin-form">
        <label>
          数量
          <input id="cdk-count" type="number" min={1} max={100} value={count} onChange={(e) => setCount(Number(e.target.value))} />
        </label>
        <label>
          面额（张）
          <input id="cdk-credits" type="number" min={1} value={credits} onChange={(e) => setCredits(Number(e.target.value))} />
        </label>
        <label>
          码前缀（选填）
          <input id="cdk-prefix" type="text" maxLength={16} value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="如 WX" />
        </label>
        <button className="admin-btn-primary" onClick={() => void generate()} disabled={busy}>
          {busy ? '生成中…' : '批量生成'}
        </button>
      </div>

      <div className="admin-toolbar">
        <select value={status} onChange={(e) => { setStatus(e.target.value as StatusFilter); setPage(1) }}>
          <option value="">全部状态</option>
          <option value="unredeemed">未兑换</option>
          <option value="redeemed">已兑换</option>
          <option value="revoked">已作废</option>
        </select>
        <input type="search" value={q} onChange={(e) => { setQ(e.target.value); setPage(1) }} placeholder="搜索码" />
        <button onClick={() => void copyCodes()} disabled={items.length === 0}>复制列表</button>
        <button onClick={exportCsv} disabled={items.length === 0}>导出 CSV</button>
        <ListCount loading={loading} total={total} unit="个" />
      </div>

      {msg && <div className="admin-alert-ok" role="status">{msg}</div>}
      {err && <div className="admin-alert-err" role="alert">{err}</div>}

      <table className="admin-table">
        <thead>
          <tr>
            <th>码</th><th>面额</th><th>状态</th><th>兑换者</th><th>创建时间</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          {items.map((c) => {
            const st = statusOf(c)
            return (
              <tr key={c.code}>
                <td className="admin-mono" data-label="码">{c.code}</td>
                <td data-label="面额">{c.credits}</td>
                <td data-label="状态"><span className={`admin-chip is-${st}`}>{STATUS_LABEL[st]}</span></td>
                <td className="admin-mono" data-label="兑换者">{c.redeemedBy ?? '—'}</td>
                <td data-label="创建时间">{c.createdAt.slice(0, 19).replace('T', ' ')}</td>
                <td data-label="操作">
                  {st === 'unredeemed' ? (
                    <button className="admin-btn-danger" onClick={() => void revoke(c.code)}>作废</button>
                  ) : (
                    <span className="admin-muted">—</span>
                  )}
                </td>
              </tr>
            )
          })}
          {loading ? (
            <ListLoadingRow colSpan={6} />
          ) : (
            items.length === 0 && <ListEmptyRow colSpan={6} text="（无匹配的 CDK）" />
          )}
        </tbody>
      </table>

      <Pager page={page} pageSize={PAGE_SIZE} total={total} onChange={setPage} />
    </section>
  )
}
