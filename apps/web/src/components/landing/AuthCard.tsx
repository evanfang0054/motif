'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Alert, Button, Card, Input, InputGroup, Label, Link, TextField } from '@heroui/react'
import { api } from '@/lib/client'

type Mode = 'login' | 'register' | 'reset'

const RESEND_COOLDOWN = 60

function isEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())
}

interface AuthCardProps {
  /** 模式由 Landing 持有：落地页默认 login，各 CTA 可显式切到 register */
  mode: Mode
  onModeChange: (m: Mode) => void
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
          <Button
            isIconOnly
            aria-label={show ? `隐藏${ariaBase}` : `显示${ariaBase}`}
            aria-pressed={show}
            size="sm"
            variant="ghost"
            onPress={() => setShow((v) => !v)}
          >
            {show ? (
              // 睁眼：当前明文
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            ) : (
              // 闭眼：当前密文
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c6.5 0 10 8 10 8a13.16 13.16 0 0 1-1.67 2.68" />
                <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3.5 8 10 8a9.74 9.74 0 0 0 5.39-1.61" />
                <path d="M2 2l20 20" />
                <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
              </svg>
            )}
          </Button>
        </InputGroup.Suffix>
      </InputGroup>
    </TextField>
  )
}

/** 登录 / 注册 / 找回密码 三合一卡片 */
function AuthCard({ mode, onModeChange }: AuthCardProps) {
  const router = useRouter()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [code, setCode] = useState('')
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

  useEffect(() => {
    // 邀请链接（/?invite=CODE）自动填充邀请码；落地页初始模式由 Landing 根据 URL 决定
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

  return (
    <Card id="auth" className="p-6" style={{ scrollMarginTop: 96 }}>
      <h2 className="text-lg font-bold">{mode === 'reset' ? '找回密码' : mode === 'register' ? '创建账号' : '欢迎回来'}</h2>
      <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>
        {mode === 'reset' ? '输入注册邮箱与验证码设置新密码。' : mode === 'register' ? '注册即送 3 张生成额度，无需绑卡。' : '登录后继续你的生成任务。'}
      </p>

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
              <Button type="button" variant="ghost" className="shrink-0" isDisabled={cooldown > 0} onPress={sendCode}>
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
          {busy ? '处理中…' : mode === 'login' ? '登录并开始生成' : mode === 'register' ? '注册并领取 3 张额度' : '重置密码'}
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
    </Card>
  )
}

export { AuthCard }
export type { Mode }
