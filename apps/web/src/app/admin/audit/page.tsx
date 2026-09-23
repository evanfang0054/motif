'use client'
import { formatDateTime } from '@/lib/format'

import { useCallback, useEffect, useState } from 'react'
import { Button, Drawer, SearchField, Table, Typography } from '@heroui/react'
import { Eye } from '@gravity-ui/icons'
import { IconButton } from '@/components/ui/icon-button'
import { api, type AdminAuditRow } from '@/lib/client'
import { ListCount, ListEmptyContent, ListLoadingRows, Pager } from '@/components/admin/ListUi'

const PAGE_SIZE = 20

/** detail 为 JSON 字符串：解析成功则缩进美化，失败原样展示 */
function formatDetail(detail: string): string {
  try {
    return JSON.stringify(JSON.parse(detail), null, 2)
  } catch {
    return detail
  }
}

export default function AdminAuditPage() {
  const [items, setItems] = useState<AdminAuditRow[]>([])
  const [total, setTotal] = useState(0)
  const [actorId, setActorId] = useState('')
  const [action, setAction] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  // 右侧抽屉查看的审计行（复查反馈：详情从行内 details 改为抽屉，保持列表上下文）
  const [detail, setDetail] = useState<AdminAuditRow | null>(null)

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
      <Typography type="h1" className="admin-title">审计日志</Typography>
      <Typography type="body" className="admin-muted">所有会改变他人或系统状态的管理动作都在这里留痕，用于回答「谁对谁做了什么」。</Typography>

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
                    {/* 详情抽屉（推荐的下钻模式：抽屉保持列表上下文） */}
                    <Table.Cell data-label="详情">
                      {r.detail ? (
                        <IconButton size="sm" variant="secondary" label="查看详情" onPress={() => setDetail(r)}>
                          <Eye />
                        </IconButton>
                      ) : (
                        '—'
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

      <Drawer.Backdrop isOpen={detail !== null} isDismissable onOpenChange={(o) => { if (!o) setDetail(null) }}>
        <Drawer.Content placement="right">
          <Drawer.Dialog>
            <Drawer.Header>
              <Drawer.Heading>审计详情</Drawer.Heading>
              <Drawer.CloseTrigger aria-label="关闭" />
            </Drawer.Header>
            <Drawer.Body>
              {detail && (
                <>
                  <dl className="audit-detail-meta">
                    <div><dt>时间</dt><dd>{formatDateTime(detail.createdAt)}</dd></div>
                    <div><dt>操作者</dt><dd className="admin-mono">{detail.actorId}</dd></div>
                    <div><dt>动作</dt><dd className="admin-mono">{detail.action}</dd></div>
                    <div><dt>目标</dt><dd className="admin-mono">{detail.targetType ? `${detail.targetType}:${detail.targetId ?? '—'}` : '—'}</dd></div>
                  </dl>
                  {detail.detail && (
                    <>
                      <div className="audit-detail-label">详情</div>
                      <pre className="audit-detail-json">{formatDetail(detail.detail)}</pre>
                    </>
                  )}
                </>
              )}
            </Drawer.Body>
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
    </section>
  )
}
