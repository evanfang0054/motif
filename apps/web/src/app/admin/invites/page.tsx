'use client'
import { formatDateTime } from '@/lib/format'

import { useCallback, useEffect, useState } from 'react'
import { Input, NumberField, Table, TextField, Typography } from '@heroui/react'
import { Copy } from '@gravity-ui/icons'
import { IconButton } from '@/components/ui/icon-button'
import { api, type AdminRegistrationInvite } from '@/lib/client'
import { ListCount, ListEmptyContent, ListLoadingRows, Pager } from '@/components/admin/ListUi'
import { useConfirm } from '@/components/admin/confirm'
import { describeAdminError } from '@/lib/admin-error'

const PAGE_SIZE = 20

type InviteStatus = 'unused' | 'used' | 'revoked'

const STATUS_LABEL: Record<InviteStatus, string> = {
  unused: '未使用',
  used: '已使用',
  revoked: '已作废',
}

/**
 * 状态由数据推导（一码一用）：作废优先于使用 —— 已作废的码不会再被核销。
 * ⚠️ chip 的类名复用 CDK 页那三个既有样式（`is-unredeemed` / `is-redeemed` / `is-revoked`），
 *    不为本页新增 CSS。
 */
const STATUS_CHIP: Record<InviteStatus, string> = {
  unused: 'is-unredeemed',
  used: 'is-redeemed',
  revoked: 'is-revoked',
}

function statusOf(i: AdminRegistrationInvite): InviteStatus {
  if (i.revokedAt) return 'revoked'
  if (i.usedBy) return 'used'
  return 'unused'
}

export default function AdminInvitesPage() {
  const [items, setItems] = useState<AdminRegistrationInvite[]>([])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const { confirm, confirmElement } = useConfirm()

  // 批量发放表单
  const [count, setCount] = useState(5)
  const [note, setNote] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await api.adminListInvites({ page, pageSize: PAGE_SIZE })
      setItems(r.items)
      setErr(null)
    } catch (e) {
      setErr(describeAdminError(e))
    } finally {
      setLoading(false)
    }
  }, [page])

  useEffect(() => {
    void load()
  }, [load])

  async function generate() {
    setBusy(true)
    setErr(null)
    setMsg(null)
    try {
      const r = await api.adminCreateInvites({ count, note: note.trim() || undefined })
      setMsg(`已发放 ${r.codes.length} 个注册准入码`)
      await load()
    } catch (e) {
      setErr(describeAdminError(e))
    } finally {
      setBusy(false)
    }
  }

  async function revoke(code: string) {
    if (!(await confirm({ message: `确认作废 ${code}？作废后不可用于注册，且不可撤销。`, confirmLabel: '作废' })))
      return
    try {
      await api.adminRevokeInvite(code)
      setMsg(`已作废 ${code}`)
      await load()
    } catch (e) {
      setErr(describeAdminError(e))
    }
  }

  async function copyCodes() {
    const text = items.map((i) => i.code).join('\n')
    try {
      await navigator.clipboard.writeText(text)
      setMsg(`已复制当前列表的 ${items.length} 个码`)
    } catch {
      setErr('浏览器拒绝了剪贴板访问，请手动选择复制')
    }
  }

  return (
    <section className="admin-panel">
      <Typography type="h1" className="admin-title">
        注册准入码
      </Typography>
      <Typography type="body" className="admin-muted">
        凭码注册可免邮箱验证码；一码一用，用完即废。它只管「谁能注册」，不建立推荐关系、不发邀请奖励。
      </Typography>

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
          备注（选填）
          <TextField className="w-full" value={note} onChange={(v) => setNote(v)} maxLength={60}>
            <Input placeholder="如 发给张三" />
          </TextField>
        </label>
        <button className="admin-btn-primary" onClick={() => void generate()} disabled={busy}>
          {busy ? '发放中…' : '批量发放'}
        </button>
      </div>

      <div className="admin-toolbar">
        <IconButton
          variant="secondary"
          label="复制列表"
          tooltip="复制当前页全部准入码"
          isDisabled={items.length === 0}
          onPress={() => void copyCodes()}
        >
          <Copy />
        </IconButton>
        <ListCount loading={loading} total={items.length} unit="个" />
      </div>

      {msg && (
        <div className="admin-alert-ok" role="status">
          {msg}
        </div>
      )}
      {err && (
        <div className="admin-alert-err" role="alert">
          {err}
        </div>
      )}

      <Table>
        <Table.ScrollContainer className="admin-table-scroll">
          <Table.Content aria-label="注册准入码列表">
            <Table.Header>
              <Table.Column isRowHeader>准入码</Table.Column>
              <Table.Column>备注</Table.Column>
              <Table.Column>状态</Table.Column>
              <Table.Column>使用者</Table.Column>
              <Table.Column>创建时间</Table.Column>
              <Table.Column>操作</Table.Column>
            </Table.Header>
            <Table.Body renderEmptyState={() => (loading ? null : <ListEmptyContent text="（还没有发放过准入码）" />)}>
              {loading ? (
                <ListLoadingRows cols={6} />
              ) : (
                items.map((i) => {
                  const st = statusOf(i)
                  return (
                    <Table.Row key={i.code}>
                      <Table.Cell className="admin-mono" data-label="准入码">
                        {i.code}
                      </Table.Cell>
                      <Table.Cell data-label="备注">{i.note ?? '—'}</Table.Cell>
                      <Table.Cell data-label="状态">
                        <span className={`admin-chip ${STATUS_CHIP[st]}`}>{STATUS_LABEL[st]}</span>
                      </Table.Cell>
                      <Table.Cell className="admin-mono" data-label="使用者">
                        {i.usedBy ?? '—'}
                      </Table.Cell>
                      <Table.Cell data-label="创建时间">{formatDateTime(i.createdAt)}</Table.Cell>
                      <Table.Cell data-label="操作">
                        {st === 'unused' ? (
                          <button className="admin-btn-danger" onClick={() => void revoke(i.code)}>
                            作废
                          </button>
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

      <Pager page={page} pageSize={PAGE_SIZE} total={items.length} onChange={setPage} />

      {confirmElement}
    </section>
  )
}
