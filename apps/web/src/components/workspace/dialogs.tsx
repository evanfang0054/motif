'use client'

import { useEffect, useState } from 'react'
import type { CreditPackage, User } from '@motif/core'
import { api } from '@/lib/client'

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="ws-modal-mask" onClick={onClose}>
      <div className="ws-modal" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-bold">{title}</h2>
          <button className="ws-btn" onClick={onClose} aria-label="关闭">✕</button>
        </div>
        {children}
      </div>
    </div>
  )
}

/** 充值弹窗：套餐列表 + 模拟收银台 + CDK 入口 */
function BillingDialog({ onClose, onPaid, onRedeem }: { onClose: () => void; onPaid: (u: User) => void; onRedeem: () => void }) {
  const [packages, setPackages] = useState<CreditPackage[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  useEffect(() => {
    void api.billingPackages().then((d) => setPackages(d.packages)).catch(() => setError('套餐加载失败'))
  }, [])

  const checkout = async (pkg: CreditPackage) => {
    setBusyId(pkg.id)
    setError(null)
    try {
      const { orderId } = await api.checkout(pkg.id)
      // 本地部署：直接走模拟收银台确认
      const res = await api.mockPay(orderId)
      onPaid(res.user)
    } catch (e) {
      setError(e instanceof Error ? e.message : '支付失败')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Modal title="充值额度" onClose={onClose}>
      <p className="text-sm" style={{ color: 'var(--muted)' }}>
        选择额度套餐，本地部署走模拟收银台；线上版将跳转 Stripe 安全支付。
        <b style={{ color: 'var(--warning)' }}>（当前为演示模式，无需真实付款）</b>
      </p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        {packages.map((pkg) => (
          <button key={pkg.id} className="ws-size-chip" style={{ padding: '12px' }} disabled={busyId !== null} onClick={() => void checkout(pkg)}>
            <b className="text-sm">{pkg.label}</b>
            <br />
            <span style={{ color: 'var(--muted)' }}>
              HK$ {(pkg.amountTotal / 100).toFixed(0)} {busyId === pkg.id ? '· 支付中…' : ''}
            </span>
          </button>
        ))}
      </div>
      {error && <div className="lp-alert lp-alert-error mt-3">{error}</div>}
      <button className="lp-link-btn mt-4" onClick={onRedeem}>
        已有 CDK？前往兑换 →
      </button>
    </Modal>
  )
}

/** CDK 兑换弹窗 */
function RedeemDialog({ onClose, onRedeemed }: { onClose: () => void; onRedeemed: (u: User) => void }) {
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const { user } = await api.redeem(code)
      onRedeemed(user)
    } catch (err) {
      setError(err instanceof Error ? err.message : '兑换失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="CDK 兑换" onClose={onClose}>
      <p className="text-sm" style={{ color: 'var(--muted)' }}>如果你已经持有 CDK，可在这里输入并兑换额度。</p>
      <form onSubmit={submit} className="mt-3 flex gap-2">
        <input className="lp-input" value={code} onChange={(e) => setCode(e.target.value)} placeholder="输入 CDK" style={{ flex: 1 }} />
        <button className="ws-btn ws-btn-primary" type="submit" disabled={busy || !code.trim()}>
          {busy ? '兑换中…' : '兑换'}
        </button>
      </form>
      {error && <div className="lp-alert lp-alert-error mt-3">{error}</div>}
    </Modal>
  )
}

/** 邀请好友弹窗 */
function InviteDialog({ user, onClose }: { user: User; onClose: () => void }) {
  const link = typeof window !== 'undefined' ? `${window.location.origin}/?invite=${user.inviteCode}` : ''
  const [copied, setCopied] = useState(false)

  return (
    <Modal title="邀请好友（获得额度）" onClose={onClose}>
      <p className="text-sm" style={{ color: 'var(--muted)', lineHeight: 1.8 }}>
        好友通过你的链接注册成功后，你获得 3 张额度，最多奖励 3 人。
        当前已邀请 <b>{user.invitedCount}</b> 人，你的邀请码：<b>{user.inviteCode}</b>
      </p>
      <div className="mt-3 flex gap-2">
        <input className="lp-input" readOnly value={link} style={{ flex: 1 }} onFocus={(e) => e.target.select()} />
        <button
          className="ws-btn ws-btn-primary"
          onClick={() => {
            void navigator.clipboard?.writeText(link)
            setCopied(true)
          }}
        >
          {copied ? '已复制' : '复制'}
        </button>
      </div>
    </Modal>
  )
}

/** 反馈弹窗 */
function FeedbackDialog({ onClose, onSent }: { onClose: () => void; onSent: () => void }) {
  const [content, setContent] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.feedback(content)
      onSent()
    } catch (err) {
      setError(err instanceof Error ? err.message : '提交失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="提交反馈" onClose={onClose}>
      <form onSubmit={submit}>
        <textarea className="ws-textarea" value={content} onChange={(e) => setContent(e.target.value)} placeholder="说说你的使用感受，或遇到的问题…" />
        {error && <div className="lp-alert lp-alert-error mt-2">{error}</div>}
        <button className="ws-btn ws-btn-primary mt-3 w-full" style={{ justifyContent: 'center' }} type="submit" disabled={busy || !content.trim()}>
          {busy ? '提交中…' : '提交反馈'}
        </button>
      </form>
    </Modal>
  )
}

/** 个人资料弹窗：昵称 + 修改密码 */
function ProfileDialog({
  user,
  onClose,
  onSaved,
  onPasswordChanged,
}: {
  user: User
  onClose: () => void
  onSaved: (u: User) => void
  onPasswordChanged: () => void
}) {
  const [name, setName] = useState(user.name)
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const saveProfile = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/auth/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      const data = (await res.json()) as { user?: User; error?: string }
      if (!res.ok || !data.user) throw new Error(data.error || '保存失败')
      onSaved(data.user)
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  const changePassword = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldPassword, newPassword }),
      })
      const data = (await res.json()) as { ok?: boolean; error?: string }
      if (!res.ok) throw new Error(data.error || '修改失败')
      onPasswordChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : '修改失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="个人资料" onClose={onClose}>
      <p className="text-xs" style={{ color: 'var(--muted)' }}>{user.email}</p>

      <form onSubmit={saveProfile} className="mt-3">
        <label className="lp-label" htmlFor="pf-name">昵称</label>
        <div className="flex gap-2">
          <input id="pf-name" className="lp-input" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1 }} />
          <button className="ws-btn ws-btn-primary" type="submit" disabled={busy || !name.trim()}>保存昵称</button>
        </div>
      </form>

      <div className="my-4" style={{ borderTop: '1px solid var(--border)' }} />

      <form onSubmit={changePassword}>
        <div className="lp-field">
          <label className="lp-label" htmlFor="pf-oldpw">当前密码</label>
          <input id="pf-oldpw" className="lp-input" type="password" value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} autoComplete="current-password" />
        </div>
        <div className="lp-field">
          <label className="lp-label" htmlFor="pf-newpw">新密码（至少 6 位）</label>
          <input id="pf-newpw" className="lp-input" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" />
        </div>
        <button className="ws-btn mt-3 w-full" style={{ justifyContent: 'center' }} type="submit" disabled={busy || !oldPassword || !newPassword}>
          修改密码
        </button>
      </form>

      {error && <div className="lp-alert lp-alert-error mt-3">{error}</div>}
    </Modal>
  )
}

export { BillingDialog, RedeemDialog, InviteDialog, FeedbackDialog, ProfileDialog }
