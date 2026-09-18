'use client'

import { useCallback, useEffect, useState } from 'react'
import type { User } from '@motif/core'
import { api } from '@/lib/client'

type RoleFilter = '' | 'user' | 'admin' | 'root'
type StatusFilter = '' | 'active' | 'disabled'

const ROLE_LABEL: Record<string, string> = { user: '普通用户', admin: '管理员', root: '超级管理员' }

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

  // 额度调整弹窗
  const [adjust, setAdjust] = useState<{ user: User; delta: string; reason: string } | null>(null)
  // 一次性密码弹窗（只此一次，不落任何持久化位置）
  const [reset, setReset] = useState<{ name: string; password: string } | null>(null)

  const isRoot = me?.role === 'root'

  const load = useCallback(async () => {
    try {
      const r = await api.adminListUsers({ q: q || undefined, role: role || undefined, status: status || undefined, pageSize: 100 })
      setItems(r.items)
      setTotal(r.total)
      setErr(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : '加载失败')
    }
  }, [q, role, status])

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
      setErr(e instanceof Error ? e.message : '调整失败')
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
    if (!window.confirm(tip)) return
    setBusy(true)
    setErr(null)
    try {
      await api.adminSetUserStatus(u.id, next)
      setMsg(next === 'disabled' ? `已禁用 ${u.name}` : `已启用 ${u.name}`)
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : '操作失败')
    } finally {
      setBusy(false)
    }
  }

  async function changeRole(u: User, next: string) {
    if (next === u.role) return
    if (!window.confirm(`确认把 ${u.name} 的角色改为「${ROLE_LABEL[next] ?? next}」？`)) return
    setBusy(true)
    setErr(null)
    try {
      await api.adminSetUserRole(u.id, next)
      setMsg(`已把 ${u.name} 的角色改为「${ROLE_LABEL[next] ?? next}」`)
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : '改角色失败')
    } finally {
      setBusy(false)
    }
  }

  async function resetPassword(u: User) {
    if (!window.confirm(`确认为 ${u.name} 重置密码？\n\n旧密码会立刻失效，该用户现有登录也会失效。新密码只显示一次。`)) return
    setBusy(true)
    setErr(null)
    try {
      const r = await api.adminResetPassword(u.id)
      setReset({ name: u.name, password: r.password })
    } catch (e) {
      setErr(e instanceof Error ? e.message : '重置失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="admin-panel">
      <h1 className="admin-title">用户</h1>

      <div className="admin-toolbar">
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索邮箱或昵称" />
        <select value={role} onChange={(e) => setRole(e.target.value as RoleFilter)}>
          <option value="">全部角色</option>
          <option value="user">普通用户</option>
          <option value="admin">管理员</option>
          <option value="root">超级管理员</option>
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
          <option value="">全部状态</option>
          <option value="active">正常</option>
          <option value="disabled">已禁用</option>
        </select>
        <span className="admin-muted">共 {total} 个</span>
      </div>

      {msg && <div className="admin-alert-ok" role="status">{msg}</div>}
      {err && <div className="admin-alert-err" role="alert">{err}</div>}

      <table className="admin-table">
        <thead>
          <tr>
            <th>邮箱</th><th>昵称</th><th>角色</th><th>状态</th><th>额度</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          {items.map((u) => {
            const isSelf = me?.id === u.id
            const isRootTarget = u.role === 'root'
            return (
              <tr key={u.id}>
                <td className="admin-mono" data-label="邮箱">{u.email}</td>
                <td data-label="昵称">{u.name}</td>
                <td data-label="角色">
                  <span className="admin-chip">{ROLE_LABEL[u.role] ?? u.role}</span>
                </td>
                <td data-label="状态">
                  <span className={`admin-chip ${u.status === 'disabled' ? 'is-revoked' : 'is-redeemed'}`}>
                    {u.status === 'disabled' ? '已禁用' : '正常'}
                  </span>
                </td>
                <td data-label="额度">{u.credits}</td>
                <td data-label="操作">
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
                </td>
              </tr>
            )
          })}
          {items.length === 0 && (
            <tr><td colSpan={6} className="admin-muted">（无匹配的用户）</td></tr>
          )}
        </tbody>
      </table>

      {adjust && (
        <div className="admin-modal-mask" onClick={() => setAdjust(null)}>
          <div className="admin-modal" role="dialog" aria-label="调整额度" onClick={(e) => e.stopPropagation()}>
            <h2 className="admin-title">调整额度 · {adjust.user.name}</h2>
            <p className="admin-muted">当前 {adjust.user.credits} 张。正数为补发，负数为回收；扣减超过余额会被拒绝。</p>
            <label className="admin-field">
              调整张数
              <input type="number" value={adjust.delta} onChange={(e) => setAdjust({ ...adjust, delta: e.target.value })} placeholder="如 25 或 -10" />
            </label>
            <label className="admin-field">
              原因（必填）
              <input type="text" maxLength={200} value={adjust.reason} onChange={(e) => setAdjust({ ...adjust, reason: e.target.value })} placeholder="如 渠道补偿" />
            </label>
            <div className="admin-actions">
              <button className="admin-btn-primary" disabled={busy || !adjust.reason.trim() || !adjust.delta} onClick={() => void submitAdjust()}>
                确认调整
              </button>
              <button disabled={busy} onClick={() => setAdjust(null)}>取消</button>
            </div>
          </div>
        </div>
      )}

      {reset && (
        <div className="admin-modal-mask" onClick={() => setReset(null)}>
          <div className="admin-modal" role="dialog" aria-label="一次性密码" onClick={(e) => e.stopPropagation()}>
            <h2 className="admin-title">一次性密码 · {reset.name}</h2>
            <p className="admin-alert-err" role="alert" style={{ display: 'block' }}>
              关闭后不再显示。请立刻通过安全渠道转交，并要求对方登录后立即修改。
            </p>
            <pre className="admin-detail">{reset.password}</pre>
            <div className="admin-actions">
              <button className="admin-btn-primary" onClick={() => void navigator.clipboard.writeText(reset.password).catch(() => undefined)}>
                复制
              </button>
              <button onClick={() => setReset(null)}>我已记录，关闭</button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
