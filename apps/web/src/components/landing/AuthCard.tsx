'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
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

/** 可见性切换的密码输入框 */
function PasswordInput({
  id,
  value,
  onChange,
  autoComplete,
  label,
}: {
  id: string
  value: string
  onChange: (v: string) => void
  autoComplete: string
  label: string
}) {
  const [show, setShow] = useState(false)
  return (
    <div style={{ position: 'relative' }}>
      <input
        id={id}
        className="lp-input"
        type={show ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        style={{ paddingRight: 44 }}
      />
      <button
        type="button"
        aria-label={show ? `隐藏${label}` : `显示${label}`}
        aria-pressed={show}
        onClick={() => setShow((v) => !v)}
        style={{
          position: 'absolute',
          right: 6,
          top: '50%',
          transform: 'translateY(-50%)',
          border: 'none',
          background: 'transparent',
          cursor: 'pointer',
          padding: 8,
          lineHeight: 0,
          color: 'var(--muted-strong)',
        }}
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
      </button>
    </div>
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
    <section id="auth" className="lp-card">
      <h2 className="text-lg font-bold">{mode === 'reset' ? '找回密码' : mode === 'register' ? '创建账号' : '欢迎回来'}</h2>
      <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>
        {mode === 'reset' ? '输入注册邮箱与验证码设置新密码。' : mode === 'register' ? '注册即送 3 张生成额度，无需绑卡。' : '登录后继续你的生成任务。'}
      </p>

      <form onSubmit={submit} className="mt-2">
        {mode === 'register' && (
          <div className="lp-field">
            <label className="lp-label" htmlFor="lp-name">昵称</label>
            <input id="lp-name" className="lp-input" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="用于头像和任务列表展示" autoComplete="nickname" />
          </div>
        )}

        <div className="lp-field">
          <label className="lp-label" htmlFor="lp-email">邮箱</label>
          <input
            id="lp-email"
            ref={emailRef}
            className="lp-input"
            type="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value)
              if (codeMsg) setCodeMsg(null)
            }}
            placeholder="you@example.com"
            autoComplete="email"
          />
        </div>

        {mode === 'register' && (
          <div className="lp-field">
            <label className="lp-label" htmlFor="lp-invite">邀请码（选填）</label>
            <input id="lp-invite" className="lp-input" type="text" value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} placeholder="选填" />
          </div>
        )}

        {mode !== 'login' && (
          <div className="lp-field">
            <label className="lp-label" htmlFor="lp-code">邮箱验证码</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input id="lp-code" className="lp-input" type="text" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} placeholder="6 位数字" style={{ flex: 1 }} autoComplete="one-time-code" />
              <button type="button" className="lp-btn lp-btn-ghost" onClick={sendCode} disabled={cooldown > 0} style={cooldown > 0 ? { opacity: 0.6, cursor: 'not-allowed' } : undefined}>
                {cooldown > 0 ? `重新发送 (${cooldown}s)` : '发送'}
              </button>
            </div>
            {codeMsg && (
              <p className="mt-1.5 text-xs" role={codeMsg.kind === 'err' ? 'alert' : 'status'} style={{ color: codeMsg.kind === 'err' ? 'var(--danger, #b3402e)' : 'var(--muted-strong)' }}>
                {codeMsg.text}
              </p>
            )}
          </div>
        )}

        <div className="lp-field">
          <label className="lp-label" htmlFor="lp-password">{mode === 'reset' ? '新密码' : '密码'}</label>
          <PasswordInput
            id="lp-password"
            label="密码"
            value={password}
            onChange={setPassword}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          />
        </div>

        {mode === 'register' && (
          <div className="lp-field">
            <label className="lp-label" htmlFor="lp-password2">确认密码</label>
            <PasswordInput id="lp-password2" label="确认密码" value={passwordConfirm} onChange={setPasswordConfirm} autoComplete="new-password" />
          </div>
        )}

        {error && <div className="lp-alert lp-alert-error" role="alert">{error}</div>}
        {notice && <div className="lp-alert lp-alert-ok">{notice}</div>}

        <button type="submit" className="lp-btn lp-btn-primary mt-4 w-full" disabled={busy}>
          {busy ? '处理中…' : mode === 'login' ? '登录并开始生成' : mode === 'register' ? '注册并领取 3 张额度' : '重置密码'}
        </button>
      </form>

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
        {mode === 'login' ? (
          <button type="button" className="lp-link-btn" onClick={() => switchMode('register')}>注册账号</button>
        ) : (
          <button type="button" className="lp-link-btn" onClick={() => switchMode('login')}>已有账号？登录</button>
        )}
        {mode !== 'reset' && (
          <button type="button" className="lp-link-btn" onClick={() => switchMode('reset')}>忘记密码？</button>
        )}
      </div>
    </section>
  )
}

export { AuthCard }
export type { Mode }
