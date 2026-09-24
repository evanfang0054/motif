'use client'
import { formatDateTime, formatMoney } from '@/lib/format'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ListBox, SearchField, Select, Table, Typography } from '@heroui/react'
import { api, type AdminOrder } from '@/lib/client'
import { ListCount, ListEmptyContent, ListLoadingRows, Pager } from '@/components/admin/ListUi'
import { describeAdminError } from '@/lib/admin-error'

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

  // 当页出现的币种集合：>1 时说明历史改过币种配置，列表是混排的
  const currencies = useMemo(() => [...new Set(items.map((o) => o.currency))], [items])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await api.adminListOrders({ status: status || undefined, userId: userId || undefined, page, pageSize: PAGE_SIZE })
      setItems(r.items)
      setTotal(r.total)
      setErr(null)
    } catch (e) {
      setErr(describeAdminError(e))
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
      {/* 币种是后台可配的（BILLING_CURRENCY），改过配置后历史订单会留下别的币种。
          混排时单看金额符号容易误读，这里显式说明当前页含哪些币种 */}
      {currencies.length > 1 && (
        <Typography type="body" className="admin-muted">
          本页含 {currencies.length} 种币种（{currencies.map((c) => c.toUpperCase()).join(' / ')}）—— 币种配置改过，历史订单保留原币种，金额不可跨币种相加。
        </Typography>
      )}

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
        <SearchField aria-label="按用户筛选" value={userId} onChange={(v) => { setUserId(v); setPage(1) }}>
          <SearchField.Group>
            <SearchField.SearchIcon />
            <SearchField.Input placeholder="按用户邮箱 / 昵称 / ID" />
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
              {/* 列宽（#79-1.1）：时间列与订单号被均分压缩后断行、状态 chip 竖排。
                  ⚠️ 必须用 `className` 上的任意值最小宽类（`min-w-…`），**不能用 `minWidth` prop**：RAC 的 `Column`
                  仅在 `ResizableTableContainer` 提供 `layoutState` 时才认 width/minWidth/maxWidth，
                  本仓没有用那个容器 —— `minWidth` 会被逐列 console.warn 警告、再被 `filterDOMProps`
                  丢掉，等于没设。className 走 HeroUI 的 `composeTwRenderProps` 合并到 `<th>`，真正生效。
                  合计最小宽 1008px，容器约 1018px —— 贴得极近，窄一点就会横向滚动
                  （`table__scroll-container` 自带 `overflow-x-auto`，可接受）。 */}
              <Table.Column isRowHeader className="min-w-[200px]">订单号</Table.Column>
              <Table.Column className="min-w-[120px]">套餐</Table.Column>
              <Table.Column className="min-w-[72px]">额度</Table.Column>
              {/* 币种单列：混排时它是唯一的「分组标识」，只看 ¥ / HK$ 符号容易看漏 */}
              <Table.Column className="min-w-[72px]">币种</Table.Column>
              <Table.Column className="min-w-[120px]">金额</Table.Column>
              <Table.Column className="min-w-[88px]">状态</Table.Column>
              <Table.Column className="min-w-[168px]">创建时间</Table.Column>
              <Table.Column className="min-w-[168px]">支付时间</Table.Column>
            </Table.Header>
            <Table.Body
              renderEmptyState={() =>
                loading ? null : <ListEmptyContent text="（无匹配的订单）" />
              }
            >
              {loading ? (
                <ListLoadingRows cols={8} />
              ) : (
                items.map((o) => (
                  <Table.Row key={o.id}>
                    <Table.Cell className="admin-mono" data-label="订单号">{o.id}</Table.Cell>
                    <Table.Cell data-label="套餐">{o.packageId}</Table.Cell>
                    <Table.Cell data-label="额度">{o.credits}</Table.Cell>
                    <Table.Cell className="admin-mono" data-label="币种">{(o.currency ?? '').toUpperCase() || '—'}</Table.Cell>
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
