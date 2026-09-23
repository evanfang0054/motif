'use client'
import { formatDateTime } from '@/lib/format'

import { useCallback, useEffect, useState } from 'react'
import { Button, Drawer, ListBox, NumberField, SearchField, Select, Table, Typography } from '@heroui/react'
import { Eye } from '@gravity-ui/icons'
import { IconButton } from '@/components/ui/icon-button'
import { api, type AdminLogRow } from '@/lib/client'
import { ListCount, ListEmptyContent, ListLoadingRows, Pager } from '@/components/admin/ListUi'
import { useConfirm } from '@/components/admin/confirm'

const STATUS_LABEL: Record<string, string> = {
  queued: '排队中',
  running: '生成中',
  canceling: '取消中',
  completed: '已完成',
  failed: '失败',
  canceled: '已取消',
}

const DAYS_DEFAULT = 90
const PAGE_SIZE = 20

export default function AdminLogsPage() {
  const [items, setItems] = useState<AdminLogRow[]>([])
  const [total, setTotal] = useState(0)
  const [status, setStatus] = useState('')
  const [userId, setUserId] = useState('')
  const [days, setDays] = useState(String(DAYS_DEFAULT))
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const { confirm, confirmElement } = useConfirm()
  // 右侧抽屉查看的日志行（与 audit 抽屉同模式）
  const [detail, setDetail] = useState<AdminLogRow | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await api.adminListLogs({ status: status || undefined, userId: userId || undefined, page, pageSize: PAGE_SIZE })
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

  async function cleanup() {
    const n = Number(days)
    if (!Number.isInteger(n) || n < 1 || n > 3650) return setErr('保留天数需为 1–3650 的整数。')
    if (
      !(await confirm({
        message: `确认清理 ${n} 天前的历史生成记录？\n\n这些记录是额度对账的唯一追溯依据，删除后无法恢复。\n只删除已结束（完成 / 失败 / 已取消）的轮次，不会删除画布图片与额度流水。`,
        confirmLabel: '清理',
      }))
    )
      return
    setBusy(true)
    setErr(null)
    try {
      const r = await api.adminCleanupLogs(n)
      setMsg(`已清理 ${r.deleted} 条（阈值 ${formatDateTime(r.before)} 之前）`)
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : '清理失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="admin-panel">
      <Typography type="h1" className="admin-title">生成日志</Typography>
      <Typography type="body" className="admin-muted">全站生成轮次视图（跨用户）。用于回答「这次生成为什么失败」。</Typography>

      <div className="admin-toolbar">
        {/* ⚠️ Select 的 value 就是 ListBox.Item 的 id，id 必须等于要回传给接口的裸值
            （动态项也要去掉 `status-` 前缀）；「全部」用哨兵 `all`，在 onChange 边界映射回 `''`。 */}
        <Select aria-label="状态筛选" value={status || 'all'} onChange={(v) => { setStatus(v === 'all' ? '' : (v as string)); setPage(1) }}>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              <ListBox.Item key="all" id="all">全部状态</ListBox.Item>
              {Object.entries(STATUS_LABEL).map(([k, v]) => (
                <ListBox.Item key={k} id={k}>{v}</ListBox.Item>
              ))}
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
        <ListCount loading={loading} total={total} unit="条" />
        <span style={{ flex: 1 }} />
        <NumberField
          className="w-full"
          style={{ width: 90 }}
          minValue={1}
          maxValue={3650}
          aria-label="清理保留天数"
          value={days === '' ? undefined : Number(days)}
          onChange={(v) => setDays(v === undefined ? '' : String(v))}
        >
          <NumberField.Group>
            <NumberField.Input />
          </NumberField.Group>
        </NumberField>
        <button className="admin-btn-danger" disabled={busy} onClick={() => void cleanup()}>
          清理 {days} 天前
        </button>
      </div>

      {msg && <div className="admin-alert-ok" role="status">{msg}</div>}
      {err && <div className="admin-alert-err" role="alert">{err}</div>}

      <Table>
        <Table.ScrollContainer className="admin-table-scroll">
          <Table.Content aria-label="生成日志列表">
            <Table.Header>
              <Table.Column isRowHeader>时间</Table.Column>
              <Table.Column>用户</Table.Column>
              <Table.Column>状态</Table.Column>
              <Table.Column>张数</Table.Column>
              <Table.Column>重试</Table.Column>
              <Table.Column>失败原因</Table.Column>
              <Table.Column>提示词</Table.Column>
            </Table.Header>
            <Table.Body
              renderEmptyState={() =>
                loading ? null : <ListEmptyContent text="（无匹配的生成记录）" />
              }
            >
              {loading ? (
                <ListLoadingRows cols={7} />
              ) : (
                items.map((m) => (
                  <Table.Row key={m.id}>
                    <Table.Cell data-label="时间">{formatDateTime(m.createdAt)}</Table.Cell>
                    <Table.Cell className="admin-mono" data-label="用户">{m.userId}</Table.Cell>
                    <Table.Cell data-label="状态">
                      <span className="admin-chip">{STATUS_LABEL[m.status] ?? m.status}</span>
                    </Table.Cell>
                    <Table.Cell data-label="张数">{m.generatedCount}/{m.requestedCount}</Table.Cell>
                    <Table.Cell data-label="重试">{m.attempts}</Table.Cell>
                    <Table.Cell data-label="失败原因">{m.error ? <span className="admin-mono">{m.error}</span> : '—'}</Table.Cell>
                    <Table.Cell data-label="提示词">
                      <IconButton size="sm" variant="secondary" label="查看详情" onPress={() => setDetail(m)}>
                        <Eye />
                      </IconButton>
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
              <Drawer.Heading>生成日志详情</Drawer.Heading>
              <Drawer.CloseTrigger aria-label="关闭" />
            </Drawer.Header>
            <Drawer.Body>
              {detail && (
                <>
                  <dl className="audit-detail-meta">
                    <div><dt>时间</dt><dd>{formatDateTime(detail.createdAt)}</dd></div>
                    <div><dt>用户</dt><dd className="admin-mono">{detail.userId}</dd></div>
                    <div><dt>状态</dt><dd>{STATUS_LABEL[detail.status] ?? detail.status}</dd></div>
                    <div><dt>张数</dt><dd>{detail.generatedCount}/{detail.requestedCount}</dd></div>
                    <div><dt>重试</dt><dd>{detail.attempts}</dd></div>
                    {detail.error && (
                      <div><dt>失败原因</dt><dd className="admin-neg">{detail.error}</dd></div>
                    )}
                  </dl>
                  <div className="audit-detail-label">用户提交的提示词</div>
                  <pre className="audit-detail-json">{detail.prompt}</pre>
                  <div className="audit-detail-label">实际发往网关的提示词</div>
                  <pre className="audit-detail-json">{detail.finalPrompt}</pre>
                </>
              )}
            </Drawer.Body>
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>

      {confirmElement}
    </section>
  )
}
