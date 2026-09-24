'use client'
import { formatDateTime } from '@/lib/format'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ListBox, Select, Table, Typography } from '@heroui/react'
import { api, type AdminFeedbackRow, type AdminUserBrief } from '@/lib/client'
import { ListCount, ListEmptyContent, ListLoadingRows, Pager } from '@/components/admin/ListUi'
import { useConfirm } from '@/components/admin/confirm'
import { userBriefMap, userDisplayLabel } from '@/lib/admin-display'
import { describeAdminError } from '@/lib/admin-error'

type StatusFilter = '' | 'pending' | 'resolved'

const PAGE_SIZE = 20

export default function AdminFeedbackPage() {
  const [items, setItems] = useState<AdminFeedbackRow[]>([])
  const [users, setUsers] = useState<AdminUserBrief[]>([])
  const [total, setTotal] = useState(0)
  const [status, setStatus] = useState<StatusFilter>('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const { confirm, confirmElement } = useConfirm()

  const userMap = useMemo(() => userBriefMap(users), [users])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await api.adminListFeedback({ status: status || undefined, page, pageSize: PAGE_SIZE })
      setItems(r.items)
      setUsers(r.users)
      setTotal(r.total)
      setErr(null)
    } catch (e) {
      setErr(describeAdminError(e))
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
      setErr(describeAdminError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="admin-panel">
      <Typography type="h1" className="admin-title">反馈</Typography>

      <div className="admin-toolbar">
        {/* ⚠️ HeroUI v3 的 Select 建在 React Aria 上，`value` 就是 `ListBox.Item` 的 id ——
            id 必须**等于要回传给接口的值**（裸值），否则接口白名单判非法后静默降级为「不过滤」。
            「全部状态」用哨兵 `all`（React Aria 不接受空串 id），在 onChange 边界映射回 `''`。 */}
        <Select aria-label="状态筛选" value={status || 'all'} onChange={(v) => { setStatus(v === 'all' ? '' : (v as StatusFilter)); setPage(1) }}>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              <ListBox.Item key="all" id="all">全部状态</ListBox.Item>
              <ListBox.Item key="pending" id="pending">待处理</ListBox.Item>
              <ListBox.Item key="resolved" id="resolved">已处理</ListBox.Item>
            </ListBox>
          </Select.Popover>
        </Select>
        <ListCount loading={loading} total={total} unit="条" />
      </div>

      {msg && <div className="admin-alert-ok" role="status">{msg}</div>}
      {err && <div className="admin-alert-err" role="alert">{err}</div>}

      <Table>
        <Table.ScrollContainer className="admin-table-scroll">
          <Table.Content aria-label="反馈列表">
            <Table.Header>
              {/* 列宽（#79-1.1）：此前状态 chip 被压成 32×53px 竖条、「标记已处理」按钮一字一行、
                  提交时间 98px 断成三行。给这几列最小宽后 chip 横排、按钮单行、时间不断行。
                  ⚠️ 必须用 `className` 上的任意值最小宽类（`min-w-…`），**不能用 `minWidth` prop**：RAC 的 `Column`
                  仅在 `ResizableTableContainer` 提供 `layoutState` 时才认 width/minWidth/maxWidth，
                  本仓没有用那个容器 —— `minWidth` 会被逐列 console.warn 警告、再被 `filterDOMProps`
                  丢掉，等于没设。className 走 HeroUI 的 `composeTwRenderProps` 合并到 `<th>`，真正生效。
                  合计最小宽 976px（本页各列之和），容器约 1018px：宽屏不滚动，窄屏会出现横向滚动
                  （`table__scroll-container` 自带 `overflow-x-auto`，可接受）。 */}
              <Table.Column isRowHeader className="min-w-[240px]">内容</Table.Column>
              <Table.Column className="min-w-[180px]">提交用户</Table.Column>
              <Table.Column className="min-w-[88px]">状态</Table.Column>
              <Table.Column className="min-w-[180px]">处理人</Table.Column>
              <Table.Column className="min-w-[168px]">提交时间</Table.Column>
              <Table.Column className="min-w-[120px]">操作</Table.Column>
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
                    {/* 提交用户与处理人都显示「昵称（邮箱）」而不是裸 usr_ ID；摘要缺失时退回 ID。
                        ID 收进 title（TableCell 自身不接受 title，故套一层 span） */}
                    <Table.Cell data-label="提交用户">
                      <span title={f.userId}>{userDisplayLabel(userMap.get(f.userId), f.userId)}</span>
                    </Table.Cell>
                    <Table.Cell data-label="状态">
                      <span className={`admin-chip ${f.status === 'pending' ? 'is-unredeemed' : 'is-redeemed'}`}>
                        {f.status === 'pending' ? '待处理' : '已处理'}
                      </span>
                    </Table.Cell>
                    <Table.Cell data-label="处理人">
                      {f.resolvedBy ? (
                        <span title={f.resolvedBy}>{userDisplayLabel(userMap.get(f.resolvedBy), f.resolvedBy)}</span>
                      ) : (
                        '—'
                      )}
                    </Table.Cell>
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
