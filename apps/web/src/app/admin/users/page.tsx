'use client'

import { useCallback, useEffect, useState } from 'react'
import { Drawer, Input, ListBox, NumberField, SearchField, Select, Table, TextField, Typography } from '@heroui/react'
import type { User } from '@motif/core'
import { api } from '@/lib/client'
import { ListCount, ListEmptyContent, ListLoadingRows, Pager } from '@/components/admin/ListUi'
import { useConfirm } from '@/components/admin/confirm'
import { describeAdminError } from '@/lib/admin-error'

type RoleFilter = '' | 'user' | 'admin' | 'root'
type StatusFilter = '' | 'active' | 'disabled'

const ROLE_LABEL: Record<string, string> = { user: '普通用户', admin: '管理员', root: '超级管理员' }
const PAGE_SIZE = 20

export default function AdminUsersPage() {
  const [me, setMe] = useState<User | null>(null)
  const [items, setItems] = useState<User[]>([])
  const [total, setTotal] = useState(0)
  const [q, setQ] = useState('')
  const [role, setRole] = useState<RoleFilter>('')
  const [status, setStatus] = useState<StatusFilter>('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const { confirm, confirmElement } = useConfirm()

  // 额度调整弹窗
  const [adjust, setAdjust] = useState<{ user: User; delta: string; reason: string } | null>(null)
  // 一次性密码弹窗（只此一次，不落任何持久化位置）
  const [reset, setReset] = useState<{ name: string; password: string } | null>(null)

  const isRoot = me?.role === 'root'

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await api.adminListUsers({ q: q || undefined, role: role || undefined, status: status || undefined, page, pageSize: PAGE_SIZE })
      setItems(r.items)
      setTotal(r.total)
      setErr(null)
    } catch (e) {
      // 失败时**清空旧数据与旧计数**：留着上一次的结果会让「筛选没生效」看起来像成功，
      // 且错误态会与一份过期数据同时出现在页面上，误导运营。
      setItems([])
      setTotal(0)
      setErr(describeAdminError(e))
    } finally {
      setLoading(false)
    }
  }, [q, role, status, page])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    void api.me().then((r) => setMe(r.user)).catch(() => setMe(null))
  }, [])

  async function submitAdjust() {
    if (!adjust) return
    const delta = Number(adjust.delta)
    if (!Number.isInteger(delta) || delta === 0) return setErr('调整张数需为非 0 整数。')
    if (!adjust.reason.trim()) return setErr('请填写调整原因。')
    setBusy(true)
    setErr(null)
    try {
      await api.adminAdjustCredits({ userId: adjust.user.id, delta, reason: adjust.reason.trim() })
      setMsg(`已为 ${adjust.user.name} 调整 ${delta > 0 ? '+' : ''}${delta} 张`)
      setAdjust(null)
      await load()
    } catch (e) {
      setErr(describeAdminError(e))
    } finally {
      setBusy(false)
    }
  }

  async function toggleStatus(u: User) {
    const next = u.status === 'disabled' ? 'active' : 'disabled'
    const tip =
      next === 'disabled'
        ? `确认禁用 ${u.name}？\n\n该用户现有登录会立即失效；正在跑的生成不会中断；额度不会变动。`
        : `确认启用 ${u.name}？其可以重新登录，额度不变。`
    if (!(await confirm({ message: tip }))) return
    setBusy(true)
    setErr(null)
    try {
      await api.adminSetUserStatus(u.id, next)
      setMsg(next === 'disabled' ? `已禁用 ${u.name}` : `已启用 ${u.name}`)
      await load()
    } catch (e) {
      setErr(describeAdminError(e))
    } finally {
      setBusy(false)
    }
  }

  async function changeRole(u: User, next: string) {
    if (next === u.role) return
    if (!(await confirm({ message: `确认把 ${u.name} 的角色改为「${ROLE_LABEL[next] ?? next}」？` }))) return
    setBusy(true)
    setErr(null)
    try {
      await api.adminSetUserRole(u.id, next)
      setMsg(`已把 ${u.name} 的角色改为「${ROLE_LABEL[next] ?? next}」`)
      await load()
    } catch (e) {
      setErr(describeAdminError(e))
    } finally {
      setBusy(false)
    }
  }

  async function resetPassword(u: User) {
    if (!(await confirm({ message: `确认为 ${u.name} 重置密码？\n\n旧密码会立刻失效，该用户现有登录也会失效。新密码只显示一次。` }))) return
    setBusy(true)
    setErr(null)
    try {
      const r = await api.adminResetPassword(u.id)
      setReset({ name: u.name, password: r.password })
    } catch (e) {
      setErr(describeAdminError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="admin-panel">
      <Typography type="h1" className="admin-title">用户</Typography>

      <div className="admin-toolbar">
        {/* 搜索三路命中：邮箱 / 昵称模糊匹配 + `usr_` ID 精确匹配（服务端 userWhere）。
            加上 ID 是因为运营从反馈/审计里看到的正是裸 ID，原样贴进来必须能定位到人 */}
        <SearchField
          aria-label="搜索邮箱 / 昵称 / ID"
          value={q}
          onChange={(v) => { setQ(v); setPage(1) }}
        >
          <SearchField.Group>
            <SearchField.SearchIcon />
            <SearchField.Input placeholder="搜索邮箱 / 昵称 / ID" />
            <SearchField.ClearButton />
          </SearchField.Group>
        </SearchField>
        {/* ⚠️ Select 的 value 就是 ListBox.Item 的 id，id 必须等于要回传给接口的裸值；
            两个下拉各自用哨兵 `all`（id 只需在同一个 ListBox 内唯一），在 onChange 边界映射回 `''`。 */}
        <Select aria-label="角色筛选" value={role || 'all'} onChange={(v) => { setRole(v === 'all' ? '' : (v as RoleFilter)); setPage(1) }}>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              <ListBox.Item key="all" id="all">全部角色</ListBox.Item>
              <ListBox.Item key="user" id="user">普通用户</ListBox.Item>
              <ListBox.Item key="admin" id="admin">管理员</ListBox.Item>
              <ListBox.Item key="root" id="root">超级管理员</ListBox.Item>
            </ListBox>
          </Select.Popover>
        </Select>
        <Select aria-label="状态筛选" value={status || 'all'} onChange={(v) => { setStatus(v === 'all' ? '' : (v as StatusFilter)); setPage(1) }}>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              <ListBox.Item key="all" id="all">全部状态</ListBox.Item>
              <ListBox.Item key="active" id="active">正常</ListBox.Item>
              <ListBox.Item key="disabled" id="disabled">已禁用</ListBox.Item>
            </ListBox>
          </Select.Popover>
        </Select>
        {/* 错误态不显示数字：此时没有可信的 total，但保留计数位并写明「暂不可用」，
            既不会误导成「共 0 个」，也不会让工具栏跳一下 */}
        <ListCount loading={loading} total={total} unit="个" errored={!!err} />
      </div>

      {msg && <div className="admin-alert-ok" role="status">{msg}</div>}

      {err ? (
        // 错误态：中文文案 + 重试入口（此前会把英文响应体原样弹出、且表格留着旧数据/旧计数）
        <div className="admin-alert-err flex items-center justify-between gap-3" role="alert">
          <span>{err}</span>
          <button className="admin-btn-primary" disabled={loading} onClick={() => void load()}>重试</button>
        </div>
      ) : (
        <>
          <Table>
            <Table.ScrollContainer className="admin-table-scroll">
              <Table.Content aria-label="用户列表">
                <Table.Header>
                  <Table.Column isRowHeader minWidth={200}>邮箱</Table.Column>
                  <Table.Column minWidth={120}>昵称</Table.Column>
                  <Table.Column minWidth={88}>角色</Table.Column>
                  <Table.Column minWidth={88}>状态</Table.Column>
                  <Table.Column minWidth={72}>额度</Table.Column>
                  <Table.Column minWidth={260}>操作</Table.Column>
                </Table.Header>
                <Table.Body
                  renderEmptyState={() =>
                    loading ? null : <ListEmptyContent text="（无匹配的用户）" />
                  }
                >
                  {loading ? (
                    <ListLoadingRows cols={6} />
                  ) : (
                    items.map((u) => {
                      const isSelf = me?.id === u.id
                      const isRootTarget = u.role === 'root'
                      return (
                        <Table.Row key={u.id}>
                          <Table.Cell className="admin-mono" data-label="邮箱">{u.email}</Table.Cell>
                          <Table.Cell data-label="昵称">{u.name}</Table.Cell>
                          <Table.Cell data-label="角色">
                            <span className="admin-chip">{ROLE_LABEL[u.role] ?? u.role}</span>
                          </Table.Cell>
                          <Table.Cell data-label="状态">
                            <span className={`admin-chip ${u.status === 'disabled' ? 'is-revoked' : 'is-redeemed'}`}>
                              {u.status === 'disabled' ? '已禁用' : '正常'}
                            </span>
                          </Table.Cell>
                          <Table.Cell data-label="额度">{u.credits}</Table.Cell>
                          <Table.Cell data-label="操作">
                            <div className="admin-actions">
                              <button
                                className="admin-btn-primary"
                                disabled={busy || isSelf || (!isRoot && isRootTarget)}
                                onClick={() => setAdjust({ user: u, delta: '', reason: '' })}
                                title={isSelf ? '不可调整自己的额度' : undefined}
                              >
                                调额度
                              </button>
                              <button
                                className="admin-btn-danger"
                                disabled={busy || isSelf || (!isRoot && isRootTarget)}
                                onClick={() => void toggleStatus(u)}
                              >
                                {u.status === 'disabled' ? '启用' : '禁用'}
                              </button>
                              {/* 改角色与重置密码是 root 独占：admin 登录时连控件都不渲染（服务端也会 403） */}
                              {isRoot && (
                                <>
                                  <select value={u.role} disabled={busy} onChange={(e) => void changeRole(u, e.target.value)}>
                                    <option value="user">普通用户</option>
                                    <option value="admin">管理员</option>
                                    <option value="root">超级管理员</option>
                                  </select>
                                  <button disabled={busy} onClick={() => void resetPassword(u)}>重置密码</button>
                                </>
                              )}
                            </div>
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
        </>
      )}

      <Drawer.Backdrop isOpen={adjust !== null} onOpenChange={(o) => { if (!o) setAdjust(null) }}>
        <Drawer.Content placement="right">
          <Drawer.Dialog>
            <Drawer.Header>
              <Drawer.Heading>调整额度 · {adjust?.user.name}</Drawer.Heading>
              <Drawer.CloseTrigger aria-label="关闭" />
            </Drawer.Header>
            <Drawer.Body>
              {adjust && (
                <>
                  <Typography type="body" className="admin-muted">当前 {adjust.user.credits} 张。正数为补发，负数为回收；扣减超过余额会被拒绝。</Typography>
                  <label className="admin-field">
                    调整张数
                    <NumberField
                      className="w-full"
                      value={adjust.delta === '' ? undefined : Number(adjust.delta)}
                      onChange={(v) => setAdjust({ ...adjust, delta: v === undefined ? '' : String(v) })}
                    >
                      <NumberField.Group>
                        <NumberField.Input placeholder="如 25 或 -10" />
                      </NumberField.Group>
                    </NumberField>
                  </label>
                  <label className="admin-field">
                    原因（必填）
                    <TextField
                      className="w-full"
                      value={adjust.reason}
                      onChange={(v) => setAdjust({ ...adjust, reason: v })}
                      maxLength={200}
                    >
                      <Input placeholder="如 渠道补偿" />
                    </TextField>
                  </label>
                  <div className="admin-actions">
                    <button className="admin-btn-primary" disabled={busy || !adjust.reason.trim() || !adjust.delta} onClick={() => void submitAdjust()}>
                      确认调整
                    </button>
                    <button disabled={busy} onClick={() => setAdjust(null)}>取消</button>
                  </div>
                </>
              )}
            </Drawer.Body>
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>

      <Drawer.Backdrop isOpen={reset !== null} onOpenChange={(o) => { if (!o) setReset(null) }}>
        <Drawer.Content placement="right">
          <Drawer.Dialog>
            <Drawer.Header>
              <Drawer.Heading>一次性密码 · {reset?.name}</Drawer.Heading>
              <Drawer.CloseTrigger aria-label="关闭" />
            </Drawer.Header>
            <Drawer.Body>
              {reset && (
                <>
                  <Typography type="body" className="admin-alert-err" role="alert" style={{ display: 'block' }}>
                    关闭后不再显示。请立刻通过安全渠道转交，并要求对方登录后立即修改。
                  </Typography>
                  <pre className="admin-detail">{reset.password}</pre>
                  <div className="admin-actions">
                    <button className="admin-btn-primary" onClick={() => void navigator.clipboard.writeText(reset.password).catch(() => undefined)}>
                      复制
                    </button>
                    <button onClick={() => setReset(null)}>我已记录，关闭</button>
                  </div>
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
