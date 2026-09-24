'use client'

import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Input, Label, Link, TextArea, TextField, Typography } from '@heroui/react'
import { Modal as HeroModal } from '@heroui/react'
import { ArrowRight, Copy, FileCheck } from '@gravity-ui/icons'
import { IconButton } from '@/components/ui/icon-button'
import { PASSWORD_RULE_TEXT, type CreditPackage, type User } from '@motif/core'
import { api } from '@/lib/client'
import { errorMessage } from '@/lib/error-message'
import { formatMoney } from '@/lib/format'
import { usePublicConfig } from '@/lib/use-public-config'

/** 通用弹窗外壳：受控开合在 Backdrop 上；关闭后把焦点还原到打开前的元素 */
function WorkspaceModal({
  title,
  children,
  onClose,
  dialogClassName,
}: {
  title: string
  children: React.ReactNode
  onClose: () => void
  /** 需要更宽/更高的弹窗时由调用方给（例如提示词库） */
  dialogClassName?: string
}) {
  // HeroUI 无触发器上下文（本壳由调用方条件挂载），关闭后手动还原焦点到打开前的元素
  const restoreRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    restoreRef.current = document.activeElement as HTMLElement | null
    return () => restoreRef.current?.focus?.()
  }, [])

  return (
    <HeroModal.Backdrop
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <HeroModal.Container>
        {/* #78-1.4：补全对话框语义。
            `role="dialog"` 其实由 HeroUI 的 Modal.Dialog → RAC Dialog → useDialog 默认给出（源码实证），
            这里显式写出来是给后来人看「这是有意的」；**真正缺的是 `aria-modal`** ——
            RAC 的 useDialog 注释说明它因 Safari 的一个焦点 bug 而刻意不写 aria-modal，
            所以提示词库 / 充值弹层此前只有 role 没有 aria-modal（读屏无法感知「这是模态」）。
            RAC 的 dialogProps 不含 aria-modal，mergeProps 会保留我们这一份。 */}
        <HeroModal.Dialog role="dialog" aria-modal="true" aria-label={title} className={dialogClassName}>
          <HeroModal.Header>
            <HeroModal.Heading>{title}</HeroModal.Heading>
            <HeroModal.CloseTrigger aria-label="关闭" />
          </HeroModal.Header>
          <HeroModal.Body>{children}</HeroModal.Body>
        </HeroModal.Dialog>
      </HeroModal.Container>
    </HeroModal.Backdrop>
  )
}

/** 弹窗外壳的旧名（各业务弹窗沿用，避免一次性改一大片调用点） */
const Modal = WorkspaceModal

/** 币种符号与金额格式统一走 `lib/format`（概览页、订单页、本弹窗共用一份映射） */
const fmtPrice = (p: CreditPackage) => formatMoney(p.amountTotal, p.currency)

/**
 * 充值弹窗：套餐列表 + 收银台分流（mock 站内确认；epay/stripe 整页跳网关/Stripe）+ CDK 入口。
 *
 * ⚠️ `onPaid` 必须把**本次到账额度**一并回传（#73-1.3）：支付成功后只能拿到 `user`，
 * 而 `user.credits` 是**充值后的总余额**，拿它当「新充额度」会写出「已充值 153 张总额度中的新额度」
 * 这种既错又不通的文案。`mockPay` 的响应里本来就有 `paid`（本次订单额度），直接透传。
 */
function BillingDialog({
  onClose,
  onPaid,
  onRedeem,
}: {
  onClose: () => void
  onPaid: (u: User, paidCredits: number) => void
  onRedeem: () => void
}) {
  const [packages, setPackages] = useState<CreditPackage[]>([])
  const [channel, setChannel] = useState<'mock' | 'epay' | 'stripe'>('mock')
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  useEffect(() => {
    void api
      .billingPackages()
      .then((d) => {
        setPackages(d.packages)
        setChannel(d.channel ?? 'mock')
      })
      .catch(() => setError('套餐加载失败'))
  }, [])

  const checkout = async (pkg: CreditPackage) => {
    setBusyId(pkg.id)
    setError(null)
    try {
      const { orderId, checkoutUrl } = await api.checkout(pkg.id)
      if (/^https?:\/\//i.test(checkoutUrl)) {
        // 真实渠道：整页跳网关/Stripe 收银页，支付完成由 return_url 带回结果页
        window.location.href = checkoutUrl
        return
      }
      // mock 渠道：站内模拟收银台确认
      const res = await api.mockPay(orderId)
      onPaid(res.user, res.paid)
    } catch (e) {
      setError(errorMessage(e, '支付失败'))
      setBusyId(null)
    }
  }

  const payNote =
    channel === 'mock'
      ? '本地部署走模拟收银台，不会产生真实扣款。'
      : channel === 'stripe'
        ? '点击后将跳转 Stripe 安全支付页，支付完成自动返回。'
        : '点击后将跳转支付网关完成付款，支付完成自动返回。'

  return (
    <Modal title="充值额度" onClose={onClose}>
      <Typography type="body-sm" style={{ color: 'var(--muted)' }}>{payNote}</Typography>
      <div className="mt-3 grid grid-cols-2 gap-2">
        {packages.map((pkg) => (
          <Button
            key={pkg.id}
            variant="outline"
            className="h-auto w-full text-start"
            isDisabled={busyId !== null}
            onPress={() => void checkout(pkg)}
          >
            <span className="block">
              <b className="text-sm">{pkg.label}</b>
              <br />
              <span style={{ color: 'var(--muted)' }}>
                {fmtPrice(pkg)} {busyId === pkg.id ? (channel === 'mock' ? '· 支付中…' : '· 跳转支付…') : ''}
              </span>
            </span>
          </Button>
        ))}
      </div>
      {error && (
        <Alert status="danger" className="mt-3">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{error}</Alert.Title>
          </Alert.Content>
        </Alert>
      )}
      <Link onPress={onRedeem} className="mt-4 block w-fit" style={{ fontSize: 13, color: 'var(--muted)' }}>
        已有 CDK？前往兑换 <ArrowRight className="ms-1 inline align-[-0.125em]" aria-hidden />
      </Link>
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
      setError(errorMessage(err, '兑换失败'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="CDK 兑换" onClose={onClose}>
      <Typography type="body-sm" style={{ color: 'var(--muted)' }}>如果你已经持有 CDK，可在这里输入并兑换额度。</Typography>
      <form onSubmit={submit} className="mt-3 flex gap-2">
        <TextField aria-label="CDK" className="min-w-0 flex-1" value={code} onChange={setCode}>
          <Input placeholder="输入 CDK" />
        </TextField>
        <Button type="submit" variant="primary" isDisabled={busy || !code.trim()}>
          {busy ? '兑换中…' : '兑换'}
        </Button>
      </form>
      {error && (
        <Alert status="danger" role="alert" className="mt-3">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{error}</Alert.Title>
          </Alert.Content>
        </Alert>
      )}
    </Modal>
  )
}

/** 邀请好友弹窗 */
function InviteDialog({ user, onClose }: { user: User; onClose: () => void }) {
  const link = typeof window !== 'undefined' ? `${window.location.origin}/?invite=${user.inviteCode}` : ''
  const [copied, setCopied] = useState(false)
  const cfg = usePublicConfig()

  return (
    <Modal title="邀请好友（获得额度）" onClose={onClose}>
      <Typography type="body-sm" style={{ color: 'var(--muted)', lineHeight: 1.8 }}>
        {cfg ? (
          <>
            好友通过你的链接注册成功后，你获得 {cfg.inviteRewardCredits} 张额度，最多奖励{' '}
            {cfg.inviteRewardMaxInvitees} 人。
          </>
        ) : (
          // 配置未取到时**不写数字**（而不是写 0）—— 与入口显隐、注册页文案同一口径
          <>好友通过你的链接注册成功后，你会获得额度奖励。</>
        )}
        当前已邀请 <b>{user.invitedCount}</b> 人，你的邀请码：<b>{user.inviteCode}</b>
      </Typography>
      <div className="mt-3 flex gap-2">
        <TextField aria-label="邀请链接" className="min-w-0 flex-1" value={link}>
          <Input readOnly onFocus={(e) => e.target.select()} />
        </TextField>
        <IconButton
          variant={copied ? 'secondary' : 'primary'}
          label={copied ? '已复制' : '复制邀请链接'}
          onPress={() => {
            void navigator.clipboard?.writeText(link)
            setCopied(true)
          }}
        >
          {copied ? <FileCheck /> : <Copy />}
        </IconButton>
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
      setError(errorMessage(err, '提交失败'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="提交反馈" onClose={onClose}>
      <form onSubmit={submit}>
        <TextField aria-label="反馈内容" className="w-full" value={content} onChange={setContent}>
          <TextArea placeholder="说说你的使用感受，或遇到的问题…" rows={5} className="w-full min-h-[120px] resize-y" />
        </TextField>
        {error && (
          <Alert status="danger" className="mt-2">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>{error}</Alert.Title>
            </Alert.Content>
          </Alert>
        )}
        <Button className="mt-3 w-full" type="submit" variant="primary" isDisabled={busy || !content.trim()}>
          {busy ? '提交中…' : '提交反馈'}
        </Button>
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
      setError(errorMessage(err, '保存失败'))
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
      setError(errorMessage(err, '修改失败'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="个人资料" onClose={onClose}>
      <Typography type="body-xs" style={{ color: 'var(--muted)' }}>{user.email}</Typography>

      <form onSubmit={saveProfile} className="mt-3">
        <div className="flex items-end gap-2">
          {/* data-testid：e2e（e2e/acceptance.sh 的 E 段）要按「哪个字段」定位，
              而本弹窗的三个输入框都没有 aria-label（标签走 <Label> 的 aria-labelledby），
              按下标取 input 太脆。仓库已有 data-testid 先例（画布区）。 */}
          <TextField className="min-w-0 flex-1" value={name} onChange={setName}>
            <Label>昵称</Label>
            <Input data-testid="profile-name" />
          </TextField>
          <Button type="submit" variant="primary" isDisabled={busy || !name.trim()}>保存昵称</Button>
        </div>
      </form>

      <div className="my-4" style={{ borderTop: '1px solid var(--border)' }} />

      <form onSubmit={changePassword}>
        <TextField type="password" autoComplete="current-password" value={oldPassword} onChange={setOldPassword} className="mt-3.5">
          <Label>当前密码</Label>
          <Input data-testid="profile-old-password" />
        </TextField>
        <TextField type="password" autoComplete="new-password" value={newPassword} onChange={setNewPassword} className="mt-3.5">
          <Label>新密码</Label>
          <Input data-testid="profile-new-password" />
        </TextField>
        {/* #74-2.1：改密与注册共用同一条复杂度规则，规则文案也共用同一份常量（界面明示） */}
        <Typography type="body-xs" className="mt-1.5" style={{ color: 'var(--muted)' }}>
          {PASSWORD_RULE_TEXT}
        </Typography>
        <Button className="mt-3 w-full" type="submit" variant="secondary" isDisabled={busy || !oldPassword || !newPassword}>
          修改密码
        </Button>
      </form>

      {/* role="alert"：改密失败（旧密码错误等）是必须被读屏立即播报的错误；顺带给 e2e 一个稳定锚点 */}
      {error && (
        <Alert status="danger" role="alert" data-testid="profile-error" className="mt-3">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{error}</Alert.Title>
          </Alert.Content>
        </Alert>
      )}
    </Modal>
  )
}

export { BillingDialog, RedeemDialog, InviteDialog, FeedbackDialog, ProfileDialog, WorkspaceModal }
