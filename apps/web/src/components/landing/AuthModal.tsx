'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Alert, Button, Input, InputGroup, Label, Link, Modal as HeroModal, TextField } from '@heroui/react'
import { Eye, EyeSlash, PaperPlane } from '@gravity-ui/icons'
import { IconButton } from '@/components/ui/icon-button'
import { api } from '@/lib/client'
import { usePublicConfig } from '@/lib/use-public-config'

type Mode = 'login' | 'register' | 'reset'

const RESEND_COOLDOWN = 60

function isEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())
}

interface AuthModalProps {
  /** 模式由 Landing 持有：默认 login，注册意图 CTA 显式切 register */
  mode: Mode
  onModeChange: (m: Mode) => void
  onClose: () => void
  /**
   * 找回密码**直达链接**带来的预填值（#21）：邮箱与验证码已由邮件链接给出，用户只需输新密码。
   * 只当 useState 的**初值**用 —— 之后以弹窗内 state 为准，不受父组件重渲染影响。
   */
  prefill?: { email: string; code: string }
}

/** 可见性切换的密码输入框（HeroUI InputGroup 形态；ariaBase 恒为字面量，不随模式变化） */
function PasswordInput({
  value,
  onChange,
  autoComplete,
  label,
  ariaBase,
}: {
  value: string
  onChange: (v: string) => void
  autoComplete: string
  label: string
  ariaBase: string
}) {
  const [show, setShow] = useState(false)
  return (
    <TextField value={value} onChange={onChange}>
      <Label>{label}</Label>
      <InputGroup>
        <InputGroup.Input type={show ? 'text' : 'password'} autoComplete={autoComplete} />
        <InputGroup.Suffix className="pe-0">
          {/* 睁眼=当前明文，闭眼=当前密文（原为手写 SVG，2026-09-21 换成图标库） */}
          <IconButton
            label={show ? `隐藏${ariaBase}` : `显示${ariaBase}`}
            aria-pressed={show}
            size="sm"
            variant="ghost"
            onPress={() => setShow((v) => !v)}
          >
            {show ? <Eye /> : <EyeSlash />}
          </IconButton>
        </InputGroup.Suffix>
      </InputGroup>
    </TextField>
  )
}

/** 登录 / 注册 / 找回密码 三合一弹窗（原 AuthCard 表单逻辑零改动，外壳 Card → HeroUI Modal） */
function AuthModal({ mode, onModeChange, onClose, prefill }: AuthModalProps) {
  const router = useRouter()
  const [name, setName] = useState('')
  // 深链预填只写进初值：用户改过之后不该被父组件的重渲染覆盖回去
  const [email, setEmail] = useState(prefill?.email ?? '')
  const [inviteCode, setInviteCode] = useState('')
  const [code, setCode] = useState(prefill?.code ?? '')
  const [password, setPassword] = useState('')
  const [passwordConfirm, setPasswordConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // 发送验证码的「就地」反馈与冷却：出现在验证码行正下方，触屏视口内必然可见
  const [codeMsg, setCodeMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [cooldown, setCooldown] = useState(0)
  const emailRef = useRef<HTMLInputElement>(null)
  const codeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // HeroUI 无触发器上下文（本壳由调用方条件挂载）：关闭后手动还原焦点到打开前的元素（与通用弹窗外壳同一套焦点还原做法）
  const restoreRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    restoreRef.current = document.activeElement as HTMLElement | null
    return () => restoreRef.current?.focus?.()
  }, [])

  useEffect(() => {
    // 邀请链接（/?invite=CODE）自动填充邀请码
    const invite = new URLSearchParams(window.location.search).get('invite')
    if (invite) setInviteCode(invite.trim().toUpperCase())
  }, [])

  useEffect(() => {
    return () => {
      if (codeTimerRef.current) clearInterval(codeTimerRef.current)
    }
  }, [])

  const startCooldown = useCallback(() => {
    setCooldown(RESEND_COOLDOWN)
    if (codeTimerRef.current) clearInterval(codeTimerRef.current)
    codeTimerRef.current = setInterval(() => {
      setCooldown((c) => {
        if (c <= 1 && codeTimerRef.current) {
          clearInterval(codeTimerRef.current)
          codeTimerRef.current = null
        }
        return c <= 1 ? 0 : c - 1
      })
    }, 1000)
  }, [])

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      setError(null)
      setNotice(null)
      setBusy(true)
      try {
        if (mode === 'login') {
          await api.login(email, password)
          router.refresh()
        } else if (mode === 'register') {
          await api.register({ name, email, code, password, passwordConfirm, inviteCode: inviteCode || undefined })
          router.refresh()
        } else {
          await fetch('/api/auth/password-reset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, code, password }),
          }).then(async (r) => {
            const d = (await r.json()) as { error?: string }
            if (!r.ok) throw new Error(d.error || '重置失败')
          })
          setNotice('密码已重置，请用新密码登录。')
          onModeChange('login')
          // 深链落地后清掉 query：验证码不该继续留在地址栏与浏览器历史里
          //（只在确实带过 reset 参数时才 replace，避免无谓地动历史记录）
          if (new URLSearchParams(window.location.search).has('reset')) router.replace('/')
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : '操作失败，请重试。')
      } finally {
        setBusy(false)
      }
    },
    [mode, name, email, code, password, passwordConfirm, inviteCode, router]
  )

  const sendCode = useCallback(async () => {
    setCodeMsg(null)
    setError(null)
    setNotice(null)
    if (cooldown > 0) return
    // 前置校验就地反馈：触屏用户点「发送」时反馈必须出现在手指附近，而不是表单底部
    if (!isEmail(email)) {
      setCodeMsg({ kind: 'err', text: '请先输入有效的邮箱地址' })
      emailRef.current?.focus()
      return
    }
    try {
      const purpose = mode === 'register' ? '/api/auth/register/send-code' : '/api/auth/password-reset/send-code'
      const res = await fetch(purpose, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      const data = (await res.json()) as { error?: string; devCode?: string }
      if (!res.ok) throw new Error(data.error || '发送失败')
      setCodeMsg({ kind: 'ok', text: data.devCode ? `验证码已发送（本地开发直出：${data.devCode}）` : '验证码已发送，请查收邮箱' })
      if (data.devCode) setCode(data.devCode)
      startCooldown()
    } catch (err) {
      setCodeMsg({ kind: 'err', text: err instanceof Error ? err.message : '发送失败' })
    }
  }, [mode, email, cooldown, startCooldown])

  const switchMode = useCallback((m: Mode) => {
    onModeChange(m)
    setError(null)
    setNotice(null)
    setCodeMsg(null)
    setCooldown(0)
  }, [])

  const title = mode === 'reset' ? '找回密码' : mode === 'register' ? '创建账号' : '欢迎回来'
  const cfg = usePublicConfig()
  const subtitle =
    mode === 'reset'
      ? '输入注册邮箱与验证码设置新密码。'
      : mode === 'register'
        ? // 配置未取到时**不写数字**（而不是写一个可能过期的 3）
          cfg
          ? `注册即送 ${cfg.signupBonusCredits} 张生成额度，无需绑卡。`
          : '注册即送生成额度，无需绑卡。'
        : '登录后继续你的生成任务。'

  return (
    <HeroModal.Backdrop
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <HeroModal.Container>
        <HeroModal.Dialog aria-label={title}>
          <HeroModal.Header>
            <HeroModal.Heading>{title}</HeroModal.Heading>
            <HeroModal.CloseTrigger aria-label="关闭" />
          </HeroModal.Header>
          <HeroModal.Body>
            <p className="text-sm" style={{ color: 'var(--muted)' }}>{subtitle}</p>

            <form onSubmit={submit} className="mt-2">
              {mode === 'register' && (
                <TextField className="mt-3.5" value={name} onChange={setName}>
                  <Label>昵称</Label>
                  <Input placeholder="用于头像和任务列表展示" autoComplete="nickname" />
                </TextField>
              )}

              <TextField
                className="mt-3.5"
                value={email}
                onChange={(v) => {
                  setEmail(v)
                  if (codeMsg) setCodeMsg(null)
                }}
              >
                <Label>邮箱</Label>
                <Input ref={emailRef} type="email" placeholder="you@example.com" autoComplete="email" />
              </TextField>

              {mode === 'register' && (
                <TextField className="mt-3.5" value={inviteCode} onChange={setInviteCode}>
                  <Label>邀请码（选填）</Label>
                  <Input placeholder="选填" />
                </TextField>
              )}

              {mode !== 'login' && (
                <>
                  <div className="mt-3.5 flex items-end gap-2">
                    <TextField className="min-w-0 flex-1" value={code} onChange={setCode}>
                      <Label>邮箱验证码</Label>
                      <Input inputMode="numeric" autoComplete="one-time-code" placeholder="6 位数字" />
                    </TextField>
                    {/* ⚠️ 这里**不能**收成纯图标：冷却期按钮是 disabled，而 disabled 的 HeroUI Button
                        带 `pointer-events: none`（@heroui/styles utilities status-disabled）+ 原生 disabled，
                        hover 与 focus 都到不了 ⇒ Tooltip 在「想知道还要等多久」的那一刻恰好打不开。
                        倒计时属于「承载状态的文案」，按口径保留可见文字 */}
                    <Button type="button" variant="outline" className="shrink-0" isDisabled={cooldown > 0} onPress={sendCode}>
                      <PaperPlane />
                      {cooldown > 0 ? `重新发送 (${cooldown}s)` : '发送'}
                    </Button>
                  </div>
                  {codeMsg && (
                    <p className="mt-1.5 text-xs" role={codeMsg.kind === 'err' ? 'alert' : 'status'} style={{ color: codeMsg.kind === 'err' ? 'var(--danger-quiet, #b3402e)' : 'var(--muted-strong)' }}>
                      {codeMsg.text}
                    </p>
                  )}
                </>
              )}

              <div className="mt-3.5">
                <PasswordInput
                  label={mode === 'reset' ? '新密码' : '密码'}
                  ariaBase="密码"
                  value={password}
                  onChange={setPassword}
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                />
              </div>

              {mode === 'register' && (
                <div className="mt-3.5">
                  <PasswordInput label="确认密码" ariaBase="确认密码" value={passwordConfirm} onChange={setPasswordConfirm} autoComplete="new-password" />
                </div>
              )}

              {error && (
                <Alert status="danger" role="alert" className="mt-3">
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Title>{error}</Alert.Title>
                  </Alert.Content>
                </Alert>
              )}
              {notice && (
                <Alert status="success" className="mt-3">
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Title>{notice}</Alert.Title>
                  </Alert.Content>
                </Alert>
              )}

              <Button type="submit" variant="primary" className="mt-4 w-full" isDisabled={busy}>
                {busy
                  ? '处理中…'
                  : mode === 'login'
                    ? '登录并开始生成'
                    : mode === 'register'
                      ? // 与副标题同源：配置未取到时**不写数字**
                        cfg
                        ? `注册并领取 ${cfg.signupBonusCredits} 张额度`
                        : '注册并领取额度'
                      : '重置密码'}
              </Button>
            </form>

            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
              {mode === 'login' ? (
                <Link onPress={() => switchMode('register')} style={{ fontSize: 13, color: 'var(--muted)' }}>注册账号</Link>
              ) : (
                <Link onPress={() => switchMode('login')} style={{ fontSize: 13, color: 'var(--muted)' }}>已有账号？登录</Link>
              )}
              {mode !== 'reset' && (
                <Link onPress={() => switchMode('reset')} style={{ fontSize: 13, color: 'var(--muted)' }}>忘记密码？</Link>
              )}
            </div>
          </HeroModal.Body>
        </HeroModal.Dialog>
      </HeroModal.Container>
    </HeroModal.Backdrop>
  )
}

export { AuthModal }
export type { Mode }
