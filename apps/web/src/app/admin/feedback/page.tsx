'use client'
import { formatDateTime } from '@/lib/format'

import { useCallback, useEffect, useState } from 'react'
import { Select, ListBox, Table } from '@heroui/react'
import { api, type AdminFeedbackRow } from '@/lib/client'
import { ListCount, ListEmptyContent, ListLoadingRows, Pager } from '@/components/admin/ListUi'
import { useConfirm } from '@/components/admin/confirm'

type StatusFilter = '' | 'pending' | 'resolved'

const PAGE_SIZE = 20

export default function AdminFeedbackPage() {
  const [items, setItems] = useState<AdminFeedbackRow[]>([])
  const [total, setTotal] = useState(0)
  const [status, setStatus] = useState<StatusFilter>('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const { confirm, confirmElement } = useConfirm()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await api.adminListFeedback({ status: status || undefined, page, pageSize: PAGE_SIZE })
      setItems(r.items)
      setTotal(r.total)
      setErr(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [status, page])

  useEffect(() => {
    void load()
  }, [load])

  async function resolve(id: number) {
    if (!(await confirm({ message: '确认把这条反馈标记为已处理？标记后不可撤销。', confirmLabel: '标记已处理' }))) return
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
        <Select aria-label="状态筛选" value={status || null} onChange={(v) => { setStatus((v as StatusFilter) ?? ''); setPage(1) }}>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              <ListBox.Item key="status-all" id="status-all">全部状态</ListBox.Item>
              <ListBox.Item key="status-pending" id="status-pending">待处理</ListBox.Item>
              <ListBox.Item key="status-resolved" id="status-resolved">已处理</ListBox.Item>
            </ListBox>
          </Select.Popover>
        </Select>
        <ListCount loading={loading} total={total} unit="条" />
      </div>

      {msg && <div className="admin-alert-ok" role="status">{msg}</div>}
      {err && <div className="admin-alert-err" role="alert">{err}</div>}

      <Table>
        <Table.ScrollContainer>
          <Table.Content aria-label="反馈列表">
            <Table.Header>
              <Table.Column isRowHeader>内容</Table.Column>
              <Table.Column>提交用户</Table.Column>
              <Table.Column>状态</Table.Column>
              <Table.Column>处理人</Table.Column>
              <Table.Column>提交时间</Table.Column>
              <Table.Column>操作</Table.Column>
            </Table.Header>
            <Table.Body
              renderEmptyState={() =>
                loading ? null : <ListEmptyContent text="（无匹配的反馈）" />
              }
            >
              {loading ? (
                <ListLoadingRows cols={6} />
              ) : (
                items.map((f) => (
                  <Table.Row key={f.id}>
                    <Table.Cell data-label="内容">{f.content}</Table.Cell>
                    <Table.Cell className="admin-mono" data-label="提交用户">{f.userId}</Table.Cell>
                    <Table.Cell data-label="状态">
                      <span className={`admin-chip ${f.status === 'pending' ? 'is-unredeemed' : 'is-redeemed'}`}>
                        {f.status === 'pending' ? '待处理' : '已处理'}
                      </span>
                    </Table.Cell>
                    <Table.Cell className="admin-mono" data-label="处理人">{f.resolvedBy ?? '—'}</Table.Cell>
                    <Table.Cell data-label="提交时间">{formatDateTime(f.createdAt)}</Table.Cell>
                    <Table.Cell data-label="操作">
                      {f.status === 'pending' ? (
                        <button className="admin-btn-primary" disabled={busy} onClick={() => void resolve(f.id)}>标记已处理</button>
                      ) : (
                        <span className="admin-muted">—</span>
                      )}
                    </Table.Cell>
                  </Table.Row>
                ))
              )}
            </Table.Body>
          </Table.Content>
        </Table.ScrollContainer>
      </Table>

      <Pager page={page} pageSize={PAGE_SIZE} total={total} onChange={setPage} />

      {confirmElement}
    </section>
  )
}
