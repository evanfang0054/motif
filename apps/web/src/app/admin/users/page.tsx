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
  // ⚠️ 取数失败与动作失败必须分开：共用一个状态时，抽屉里的校验失败（「调整张数需为非 0 整数。」）、
  // 调额度 403、改角色「不可失去最后一个超管」等都会走进整页错误态，把整张用户表换成错误块
  // （此前是表格上方的 banner）。只有 `load()` 失败才是「这张表不可信」。
  const [listErr, setListErr] = useState<string | null>(null)
  const [actionErr, setActionErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const { confirm, confirmElement } = useConfirm()

  // 额度调整弹窗
  const [adjust, setAdjust] = useState<{ user: User; delta: string; reason: string } | null>(null)
  // 一次性密码弹窗（只此一次，不落任何持久化位置）
  const [reset, setReset] = useState<{ name: string; password: string } | null>(null)
  // 建号抽屉：表单 → 提交后切到「凭据一次性展示」视图
  const [create, setCreate] = useState<{ email: string; name: string; credits: string; role: 'user' | 'admin' } | null>(null)
  // 建号成功后的一次性凭据（与重置密码共用同一份展示形态）
  const [created, setCreated] = useState<{ name: string; password: string } | null>(null)

  const isRoot = me?.role === 'root'

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await api.adminListUsers({ q: q || undefined, role: role || undefined, status: status || undefined, page, pageSize: PAGE_SIZE })
      setItems(r.items)
      setTotal(r.total)
      setListErr(null)
    } catch (e) {
      // 失败时**清空旧数据与旧计数**：留着上一次的结果会让「筛选没生效」看起来像成功，
      // 且错误态会与一份过期数据同时出现在页面上，误导运营。
      setItems([])
      setTotal(0)
      setListErr(describeAdminError(e))
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
    if (!Number.isInteger(delta) || delta === 0) return setActionErr('调整张数需为非 0 整数。')
    if (!adjust.reason.trim()) return setActionErr('请填写调整原因。')
    setBusy(true)
    setActionErr(null)
    try {
      await api.adminAdjustCredits({ userId: adjust.user.id, delta, reason: adjust.reason.trim() })
      setMsg(`已为 ${adjust.user.name} 调整 ${delta > 0 ? '+' : ''}${delta} 张`)
      setAdjust(null)
      await load()
    } catch (e) {
      setActionErr(describeAdminError(e))
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
    setActionErr(null)
    try {
      await api.adminSetUserStatus(u.id, next)
      setMsg(next === 'disabled' ? `已禁用 ${u.name}` : `已启用 ${u.name}`)
      await load()
    } catch (e) {
      setActionErr(describeAdminError(e))
    } finally {
      setBusy(false)
    }
  }

  async function changeRole(u: User, next: string) {
    if (next === u.role) return
    if (!(await confirm({ message: `确认把 ${u.name} 的角色改为「${ROLE_LABEL[next] ?? next}」？` }))) return
    setBusy(true)
    setActionErr(null)
    try {
      await api.adminSetUserRole(u.id, next)
      setMsg(`已把 ${u.name} 的角色改为「${ROLE_LABEL[next] ?? next}」`)
      await load()
    } catch (e) {
      setActionErr(describeAdminError(e))
    } finally {
      setBusy(false)
    }
  }

  async function resetPassword(u: User) {
    if (!(await confirm({ message: `确认为 ${u.name} 重置密码？\n\n旧密码会立刻失效，该用户现有登录也会失效。新密码只显示一次。` }))) return
    setBusy(true)
    setActionErr(null)
    try {
      const r = await api.adminResetPassword(u.id)
      setReset({ name: u.name, password: r.password })
    } catch (e) {
      setActionErr(describeAdminError(e))
    } finally {
      setBusy(false)
    }
  }

  async function submitCreate() {
    if (!create) return
    const credits = create.credits === '' ? 0 : Number(create.credits)
    if (!Number.isInteger(credits) || credits < 0) return setActionErr('初始额度需为非负整数。')
    setBusy(true)
    setActionErr(null)
    try {
      const r = await api.adminCreateUser({
        email: create.email.trim(),
        name: create.name.trim(),
        credits,
        role: create.role,
      })
      setCreate(null)
      setCreated({ name: r.user.name, password: r.password })
      setMsg(`已创建 ${r.user.name}`)
      await load()
    } catch (e) {
      setActionErr(describeAdminError(e))
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
        <ListCount loading={loading} total={total} unit="个" errored={!!listErr} />
        <button
          className="admin-btn-primary"
          onClick={() => { setActionErr(null); setCreate({ email: '', name: '', credits: '0', role: 'user' }) }}
        >
          创建用户
        </button>
      </div>

      {msg && <div className="admin-alert-ok" role="status">{msg}</div>}
      {/* 动作失败（校验 / 403 / 网络异常）只影响这一次操作，表本身仍然可信 —— 用表格上方的 banner 提示，
          不换成整页错误块（否则运营会以为整张用户表都坏了，也丢掉了继续操作其他人的入口） */}
      {actionErr && <div className="admin-alert-err" role="alert">{actionErr}</div>}

      {listErr ? (
        // 整页错误态：只有**列表取数失败**才走到这里（中文文案 + 重试入口）
        <div className="admin-alert-err flex items-center justify-between gap-3" role="alert">
          <span>{listErr}</span>
          <button className="admin-btn-primary" disabled={loading} onClick={() => void load()}>重试</button>
        </div>
      ) : (
        <>
          <Table>
            <Table.ScrollContainer className="admin-table-scroll">
              <Table.Content aria-label="用户列表">
                <Table.Header>
                  {/* 列宽（#79-1.1）：操作列要横排「调额度 / 禁用 / 改角色下拉 / 重置密码」四个控件，
                      邮箱列要放下完整地址，否则会被均分压缩成竖条。
                      ⚠️ 必须用 `className` 上的任意值最小宽类（`min-w-…`），**不能用 `minWidth` prop**：RAC 的 `Column`
                      仅在 `ResizableTableContainer` 提供 `layoutState` 时才认 width/minWidth/maxWidth，
                      本仓没有用那个容器 —— `minWidth` 会被逐列 console.warn 警告、再被 `filterDOMProps`
                      丢掉，等于没设。className 走 HeroUI 的 `composeTwRenderProps` 合并到 `<th>`，真正生效。
                      合计最小宽 828px（各列之和），容器约 1018px；更窄的视口会横向滚动
                      （`table__scroll-container` 自带 `overflow-x-auto`）。 */}
                  <Table.Column isRowHeader className="min-w-[200px]">邮箱</Table.Column>
                  <Table.Column className="min-w-[120px]">昵称</Table.Column>
                  <Table.Column className="min-w-[88px]">角色</Table.Column>
                  <Table.Column className="min-w-[88px]">状态</Table.Column>
                  <Table.Column className="min-w-[72px]">额度</Table.Column>
                  <Table.Column className="min-w-[260px]">操作</Table.Column>
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
                                  {/* ⚠️ 全站唯一保留的**原生**表单控件（2026-09-24 走查确认）：它在表格行内，
                                      原生下拉比 HeroUI 的 popover Select 更稳、更省事；且它本就有 UA 边框，
                                      不属于「输入框缺边框」那一类。要换 HeroUI Select 请单独做（会改交互与可访问性）。 */}
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

      <Drawer.Backdrop isOpen={create !== null} onOpenChange={(o) => { if (!o) setCreate(null) }}>
        <Drawer.Content placement="right">
          <Drawer.Dialog>
            <Drawer.Header>
              <Drawer.Heading>创建用户</Drawer.Heading>
              <Drawer.CloseTrigger aria-label="关闭" />
            </Drawer.Header>
            <Drawer.Body>
              {create && (
                <>
                  <Typography type="body" className="admin-muted">
                    提交后会生成一次性密码，只显示一次。新用户首次登录必须修改密码。
                  </Typography>
                  <label className="admin-field">
                    邮箱
                    <TextField className="w-full" value={create.email} onChange={(v) => setCreate({ ...create, email: v })}>
                      <Input placeholder="如 teammate@example.com" />
                    </TextField>
                  </label>
                  <label className="admin-field">
                    昵称
                    <TextField className="w-full" value={create.name} onChange={(v) => setCreate({ ...create, name: v })} maxLength={40}>
                      <Input placeholder="如 设计小王" />
                    </TextField>
                  </label>
                  <label className="admin-field">
                    初始额度
                    <NumberField
                      className="w-full"
                      value={create.credits === '' ? undefined : Number(create.credits)}
                      onChange={(v) => setCreate({ ...create, credits: v === undefined ? '' : String(v) })}
                    >
                      <NumberField.Group>
                        <NumberField.Input placeholder="默认 0" />
                      </NumberField.Group>
                    </NumberField>
                  </label>
                  {/* 「管理员」项仅 root 可见 —— 与服务端 403 同口径（服务端才是权威，这里只是不给出入口） */}
                  {isRoot && (
                    <label className="admin-field">
                      角色
                      <Select value={create.role} onChange={(v) => setCreate({ ...create, role: v as 'user' | 'admin' })}>
                        <Select.Trigger>
                          <Select.Value />
                          <Select.Indicator />
                        </Select.Trigger>
                        <Select.Popover>
                          <ListBox>
                            <ListBox.Item key="user" id="user">普通用户</ListBox.Item>
                            <ListBox.Item key="admin" id="admin">管理员</ListBox.Item>
                          </ListBox>
                        </Select.Popover>
                      </Select>
                    </label>
                  )}
                  <div className="admin-actions">
                    <button
                      className="admin-btn-primary"
                      disabled={busy || !create.email.trim() || !create.name.trim()}
                      onClick={() => void submitCreate()}
                    >
                      创建
                    </button>
                    <button disabled={busy} onClick={() => setCreate(null)}>取消</button>
                  </div>
                </>
              )}
            </Drawer.Body>
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>

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

      <Drawer.Backdrop isOpen={created !== null} onOpenChange={(o) => { if (!o) setCreated(null) }}>
        <Drawer.Content placement="right">
          <Drawer.Dialog>
            <Drawer.Header>
              <Drawer.Heading>一次性密码 · {created?.name}</Drawer.Heading>
              <Drawer.CloseTrigger aria-label="关闭" />
            </Drawer.Header>
            <Drawer.Body>
              {created && (
                <>
                  <Typography type="body" className="admin-alert-err" role="alert" style={{ display: 'block' }}>
                    关闭后不再显示。请立刻通过安全渠道转交，并要求对方登录后立即修改。
                  </Typography>
                  <pre className="admin-detail">{created.password}</pre>
                  <div className="admin-actions">
                    <button className="admin-btn-primary" onClick={() => void navigator.clipboard.writeText(created.password).catch(() => undefined)}>
                      复制
                    </button>
                    <button onClick={() => setCreated(null)}>我已记录，关闭</button>
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
