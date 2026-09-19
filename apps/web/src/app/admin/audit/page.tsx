'use client'
import { formatDateTime } from '@/lib/format'

import { useCallback, useEffect, useState } from 'react'
import { SearchField, Table } from '@heroui/react'
import { api, type AdminAuditRow } from '@/lib/client'
import { ListCount, ListEmptyContent, ListLoadingRows, Pager } from '@/components/admin/ListUi'

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
        <SearchField aria-label="按操作者 ID 筛选" value={actorId} onChange={(v) => { setActorId(v); setPage(1) }}>
          <SearchField.Group>
            <SearchField.SearchIcon />
            <SearchField.Input placeholder="按操作者 ID 筛选" />
            <SearchField.ClearButton />
          </SearchField.Group>
        </SearchField>
        <SearchField aria-label="按动作精确筛选" value={action} onChange={(v) => { setAction(v); setPage(1) }}>
          <SearchField.Group>
            <SearchField.SearchIcon />
            <SearchField.Input placeholder="按动作精确筛选，如 credit.adjust" />
            <SearchField.ClearButton />
          </SearchField.Group>
        </SearchField>
        <ListCount loading={loading} total={total} unit="条" />
      </div>

      {err && <div className="admin-alert-err" role="alert">{err}</div>}

      <Table>
        <Table.ScrollContainer className="admin-table-scroll">
          <Table.Content aria-label="审计日志列表">
            <Table.Header>
              <Table.Column isRowHeader>时间</Table.Column>
              <Table.Column>操作者</Table.Column>
              <Table.Column>动作</Table.Column>
              <Table.Column>目标</Table.Column>
              <Table.Column>详情</Table.Column>
            </Table.Header>
            <Table.Body
              renderEmptyState={() =>
                loading ? null : <ListEmptyContent text="（无匹配的审计记录）" />
              }
            >
              {loading ? (
                <ListLoadingRows cols={5} />
              ) : (
                items.map((r) => (
                  <Table.Row key={r.id}>
                    <Table.Cell data-label="时间">{formatDateTime(r.createdAt)}</Table.Cell>
                    <Table.Cell className="admin-mono" data-label="操作者">{r.actorId}</Table.Cell>
                    <Table.Cell className="admin-mono" data-label="动作">{r.action}</Table.Cell>
                    <Table.Cell className="admin-mono" data-label="目标">{r.targetType ? `${r.targetType}:${r.targetId ?? '—'}` : '—'}</Table.Cell>
                    {/* detail 是 JSON 字符串，原样展示不美化 —— 它可能很长，折叠起来 */}
                    <Table.Cell data-label="详情">
                      {r.detail ? <details><summary>展开</summary><pre className="admin-detail">{r.detail}</pre></details> : '—'}
                    </Table.Cell>
                  </Table.Row>
                ))
              )}
            </Table.Body>
          </Table.Content>
        </Table.ScrollContainer>
      </Table>

      <Pager page={page} pageSize={PAGE_SIZE} total={total} onChange={setPage} />
    </section>
  )
}
