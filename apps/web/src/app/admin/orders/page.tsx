'use client'
import { formatDateTime, formatMoney } from '@/lib/format'

import { useCallback, useEffect, useState } from 'react'
import { ListBox, SearchField, Select, Table, Typography } from '@heroui/react'
import { api, type AdminOrder } from '@/lib/client'
import { ListCount, ListEmptyContent, ListLoadingRows, Pager } from '@/components/admin/ListUi'

const PAGE_SIZE = 20

const STATUS_LABEL: Record<string, string> = {
  pending: '待支付',
  paid: '已支付',
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
      <Typography type="h1" className="admin-title">订单</Typography>
      <Typography type="body" className="admin-muted">
        订单为只读记录。当前唯一支付路径是模拟收银台，「已支付」不等于真实收款。
      </Typography>

      <div className="admin-toolbar">
        {/* ⚠️ Select 的 value 就是 ListBox.Item 的 id，id 必须等于要回传给接口的裸值；
            「全部」用哨兵 `all`，在 onChange 边界映射回 `''`（空串 id 不被 React Aria 接受）。 */}
        <Select aria-label="状态筛选" value={status || 'all'} onChange={(v) => { setStatus(v === 'all' ? '' : (v as string)); setPage(1) }}>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              <ListBox.Item key="all" id="all">全部状态</ListBox.Item>
              <ListBox.Item key="pending" id="pending">待支付</ListBox.Item>
              <ListBox.Item key="paid" id="paid">已支付</ListBox.Item>
            </ListBox>
          </Select.Popover>
        </Select>
        <SearchField aria-label="按用户 ID 筛选" value={userId} onChange={(v) => { setUserId(v); setPage(1) }}>
          <SearchField.Group>
            <SearchField.SearchIcon />
            <SearchField.Input placeholder="按用户 ID 筛选" />
            <SearchField.ClearButton />
          </SearchField.Group>
        </SearchField>
        <ListCount loading={loading} total={total} unit="笔" />
      </div>

      {err && <div className="admin-alert-err" role="alert">{err}</div>}

      <Table>
        <Table.ScrollContainer className="admin-table-scroll">
          <Table.Content aria-label="订单列表">
            <Table.Header>
              <Table.Column isRowHeader>订单号</Table.Column>
              <Table.Column>套餐</Table.Column>
              <Table.Column>额度</Table.Column>
              <Table.Column>金额</Table.Column>
              <Table.Column>状态</Table.Column>
              <Table.Column>创建时间</Table.Column>
              <Table.Column>支付时间</Table.Column>
            </Table.Header>
            <Table.Body
              renderEmptyState={() =>
                loading ? null : <ListEmptyContent text="（无匹配的订单）" />
              }
            >
              {loading ? (
                <ListLoadingRows cols={7} />
              ) : (
                items.map((o) => (
                  <Table.Row key={o.id}>
                    <Table.Cell className="admin-mono" data-label="订单号">{o.id}</Table.Cell>
                    <Table.Cell data-label="套餐">{o.packageId}</Table.Cell>
                    <Table.Cell data-label="额度">{o.credits}</Table.Cell>
                    {/* amountTotal 以「分」存储（868 = HK$8.68），符号与小数位由 lib/format 统一决定 */}
                    <Table.Cell data-label="金额">{formatMoney(o.amountTotal, o.currency)}</Table.Cell>
                    <Table.Cell data-label="状态"><span className="admin-chip">{STATUS_LABEL[o.status] ?? o.status}</span></Table.Cell>
                    <Table.Cell data-label="创建时间">{formatDateTime(o.createdAt)}</Table.Cell>
                    <Table.Cell data-label="支付时间">{formatDateTime(o.paidAt)}</Table.Cell>
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
