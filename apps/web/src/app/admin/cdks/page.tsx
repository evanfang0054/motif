'use client'
import { formatDateTime } from '@/lib/format'

import { useCallback, useEffect, useState } from 'react'
import { Button, Input, ListBox, NumberField, SearchField, Select, Table, TextField, Typography } from '@heroui/react'
import { Copy, FileArrowDown } from '@gravity-ui/icons'
import { IconButton } from '@/components/ui/icon-button'
import { api, type AdminCdk } from '@/lib/client'
import { buildCdkCsv } from '@/lib/admin-csv'
import { ListCount, ListEmptyContent, ListLoadingRows, Pager } from '@/components/admin/ListUi'
import { useConfirm } from '@/components/admin/confirm'

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
  const { confirm, confirmElement } = useConfirm()

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
    if (!(await confirm({ message: `确认作废 ${code}？作废后不可兑换，且不可撤销。`, confirmLabel: '作废' }))) return
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
      <Typography type="h1" className="admin-title">CDK 管理</Typography>

      <div className="admin-form">
        <label>
          数量
          <NumberField minValue={1} maxValue={100} className="w-full" value={count} onChange={(v) => setCount(v ?? 1)}>
            <NumberField.Group>
              <NumberField.Input />
            </NumberField.Group>
          </NumberField>
        </label>
        <label>
          面额（张）
          <NumberField minValue={1} className="w-full" value={credits} onChange={(v) => setCredits(v ?? 1)}>
            <NumberField.Group>
              <NumberField.Input />
            </NumberField.Group>
          </NumberField>
        </label>
        <label>
          码前缀（选填）
          <TextField className="w-full" value={prefix} onChange={(v) => setPrefix(v)} maxLength={16}>
            <Input placeholder="如 WX" />
          </TextField>
        </label>
        <button className="admin-btn-primary" onClick={() => void generate()} disabled={busy}>
          {busy ? '生成中…' : '批量生成'}
        </button>
      </div>

      <div className="admin-toolbar">
        {/* ⚠️ Select 的 value 就是 ListBox.Item 的 id，id 必须等于要回传给接口的裸值；
            「全部」用哨兵 `all`，在 onChange 边界映射回 `''`（空串 id 不被 React Aria 接受）。 */}
        <Select aria-label="状态筛选" value={status || 'all'} onChange={(v) => { setStatus(v === 'all' ? '' : (v as StatusFilter)); setPage(1) }}>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              <ListBox.Item key="all" id="all">全部状态</ListBox.Item>
              <ListBox.Item key="unredeemed" id="unredeemed">未兑换</ListBox.Item>
              <ListBox.Item key="redeemed" id="redeemed">已兑换</ListBox.Item>
              <ListBox.Item key="revoked" id="revoked">已作废</ListBox.Item>
            </ListBox>
          </Select.Popover>
        </Select>
        <SearchField aria-label="搜索码" value={q} onChange={(v) => { setQ(v); setPage(1) }}>
          <SearchField.Group>
            <SearchField.SearchIcon />
            <SearchField.Input placeholder="搜索码" />
            <SearchField.ClearButton />
          </SearchField.Group>
        </SearchField>
        <IconButton variant="secondary" label="复制列表" tooltip="复制当前页全部 CDK" isDisabled={items.length === 0} onPress={() => void copyCodes()}>
          <Copy />
        </IconButton>
        <IconButton variant="secondary" label="导出 CSV" tooltip="导出筛选结果（CSV）" isDisabled={items.length === 0} onPress={exportCsv}>
          <FileArrowDown />
        </IconButton>
        <ListCount loading={loading} total={total} unit="个" />
      </div>

      {msg && <div className="admin-alert-ok" role="status">{msg}</div>}
      {err && <div className="admin-alert-err" role="alert">{err}</div>}

      <Table>
        <Table.ScrollContainer className="admin-table-scroll">
          <Table.Content aria-label="CDK 列表">
            <Table.Header>
              <Table.Column isRowHeader>码</Table.Column>
              <Table.Column>面额</Table.Column>
              <Table.Column>状态</Table.Column>
              <Table.Column>兑换者</Table.Column>
              <Table.Column>创建时间</Table.Column>
              <Table.Column>操作</Table.Column>
            </Table.Header>
            <Table.Body
              renderEmptyState={() =>
                loading ? null : <ListEmptyContent text="（无匹配的 CDK）" />
              }
            >
              {loading ? (
                <ListLoadingRows cols={6} />
              ) : (
                items.map((c) => {
                  const st = statusOf(c)
                  return (
                    <Table.Row key={c.code}>
                      <Table.Cell className="admin-mono" data-label="码">{c.code}</Table.Cell>
                      <Table.Cell data-label="面额">{c.credits}</Table.Cell>
                      <Table.Cell data-label="状态"><span className={`admin-chip is-${st}`}>{STATUS_LABEL[st]}</span></Table.Cell>
                      <Table.Cell className="admin-mono" data-label="兑换者">{c.redeemedBy ?? '—'}</Table.Cell>
                      <Table.Cell data-label="创建时间">{formatDateTime(c.createdAt)}</Table.Cell>
                      <Table.Cell data-label="操作">
                        {st === 'unredeemed' ? (
                          <button className="admin-btn-danger" onClick={() => void revoke(c.code)}>作废</button>
                        ) : (
                          <span className="admin-muted">—</span>
                        )}
                      </Table.Cell>
                    </Table.Row>
                  )
                })
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
