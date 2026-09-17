'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { api } from '@/lib/client'

type Mode = 'login' | 'register' | 'reset'

/** 登录 / 注册 / 找回密码 三合一卡片 */
function AuthCard() {
  const router = useRouter()
  const [mode, setMode] = useState<Mode>('login')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [passwordConfirm, setPasswordConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // 邀请链接（/?invite=CODE）进入时自动切到注册页并填充邀请码
  useEffect(() => {
    const invite = new URLSearchParams(window.location.search).get('invite')
    if (invite) {
      setInviteCode(invite.trim().toUpperCase())
      setMode('register')
    }
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
          setMode('login')
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
    setError(null)
    setNotice(null)
    try {
      const purpose = mode === 'register' ? '/api/auth/register/send-code' : '/api/auth/password-reset/send-code'
      const res = await fetch(purpose, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      const data = (await res.json()) as { error?: string; devCode?: string }
      if (!res.ok) throw new Error(data.error || '发送失败')
      setNotice(data.devCode ? `验证码已发送（本地开发模式直出：${data.devCode}）` : '验证码已发送，请查收邮箱。')
      if (data.devCode) setCode(data.devCode)
    } catch (err) {
      setError(err instanceof Error ? err.message : '发送失败')
    }
  }, [mode, email])

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
            <input id="lp-name" className="lp-input" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="用于头像和任务列表展示" />
          </div>
        )}

        <div className="lp-field">
          <label className="lp-label" htmlFor="lp-email">邮箱</label>
          <input id="lp-email" className="lp-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" />
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
              <input id="lp-code" className="lp-input" type="text" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} placeholder="6 位数字" style={{ flex: 1 }} />
              <button type="button" className="lp-btn lp-btn-ghost" onClick={sendCode}>发送</button>
            </div>
          </div>
        )}

        <div className="lp-field">
          <label className="lp-label" htmlFor="lp-password">{mode === 'reset' ? '新密码' : '密码'}</label>
          <input id="lp-password" className="lp-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
        </div>

        {mode === 'register' && (
          <div className="lp-field">
            <label className="lp-label" htmlFor="lp-password2">确认密码</label>
            <input id="lp-password2" className="lp-input" type="password" value={passwordConfirm} onChange={(e) => setPasswordConfirm(e.target.value)} autoComplete="new-password" />
          </div>
        )}

        {error && <div className="lp-alert lp-alert-error" role="alert">{error}</div>}
        {notice && <div className="lp-alert lp-alert-ok">{notice}</div>}

        <button type="submit" className="lp-btn lp-btn-primary mt-4 w-full" disabled={busy}>
          {busy ? '处理中…' : mode === 'login' ? '登录并开始生成' : mode === 'register' ? '注册' : '重置密码'}
        </button>
      </form>

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
        {mode === 'login' && (
          <>
            <button type="button" className="lp-link-btn" onClick={() => { setMode('register'); setError(null); setNotice(null) }}>注册账号</button>
            <button type="button" className="lp-link-btn" onClick={() => { setMode('reset'); setError(null); setNotice(null) }}>忘记密码？</button>
          </>
        )}
        {mode !== 'login' && (
          <button type="button" className="lp-link-btn" onClick={() => { setMode('login'); setError(null); setNotice(null) }}>已有账号？登录</button>
        )}
      </div>
    </section>
  )
}

export { AuthCard }
