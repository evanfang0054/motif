'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Alert, Button, Input, InputGroup, Label, Link, Modal as HeroModal, TextField, Typography } from '@heroui/react'
import { Eye, EyeSlash, PaperPlane } from '@gravity-ui/icons'
import { PASSWORD_RULE_TEXT, validateEmail, validatePassword, validatePasswordConfirm, validateVerificationCode } from '@motif/core'
import { IconButton } from '@/components/ui/icon-button'
import { api } from '@/lib/client'
import { usePublicConfig } from '@/lib/use-public-config'
import type { ResetPrefill } from '@/lib/reset-link'

type Mode = 'login' | 'register' | 'reset'

const RESEND_COOLDOWN = 60

function isEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())
}

/** 表单字段快照（三种视图共用同一批 state） */
interface AuthFields {
  name: string
  email: string
  code: string
  password: string
  passwordConfirm: string
}

/**
 * 客户端**先行**校验：返回第一条错误文案，全部通过返回 null（#74-2.2 必填 / #74-2.1 密码规则 / #80-1.1 内联报错）。
 *
 * 为什么必须在发请求之前做：
 * 1) 这些错误原本要等一个来回才由服务端返回；注册表单较长、报错落在对话框底部，用户很容易误判成「点了没反应」；
 * 2) 服务端文案是**兜底**，不是唯一的反馈渠道 —— 客户端与服务端共用 core 里的同一条规则，不会出现两侧口径分叉。
 * 顺序刻意与用户填写顺序一致（必填 → 格式 → 规则 → 两次一致），一次只报一条，改一个填一个。
 */
function clientAuthError(mode: Mode, f: AuthFields): string | null {
  if (mode === 'register') {
    if (!f.name.trim()) return '请输入昵称。'
    if (!f.email.trim()) return '请输入邮箱。'
    if (!f.code.trim()) return '请输入 6 位邮箱验证码。'
    if (!f.password) return '请输入密码。'
    if (!f.passwordConfirm) return '请再次输入密码。'
    const emailErr = validateEmail(f.email)
    if (emailErr) return emailErr
    const codeErr = validateVerificationCode(f.code)
    if (codeErr) return codeErr
    const pwdErr = validatePassword(f.password)
    if (pwdErr) return pwdErr
    return validatePasswordConfirm(f.password, f.passwordConfirm)
  }
  if (mode === 'reset') {
    if (!f.email.trim()) return '请输入邮箱。'
    if (!f.code.trim()) return '请输入 6 位邮箱验证码。'
    if (!f.password) return '请输入新密码。'
    const emailErr = validateEmail(f.email)
    if (emailErr) return emailErr
    const codeErr = validateVerificationCode(f.code)
    if (codeErr) return codeErr
    return validatePassword(f.password)
  }
  // 登录：只拦空值 —— 邮箱格式错误与凭据错误都归服务端统一口径（「邮箱或密码不正确。」），
  // 免得客户端把「账号不存在」与「邮箱写错」说成两句不同的话，反而泄露账号是否存在。
  if (!f.email.trim()) return '请输入邮箱。'
  if (!f.password) return '请输入密码。'
  return null
}

/**
 * 必填是否齐全（只判「非空」，不判格式与规则）—— 用于提交按钮置灰。
 * 与 clientAuthError 分工：空表单直接不让点（#74-2.2），格式/规则类错误点下去就地报（能说清为什么）。
 */
function isFormFilled(mode: Mode, f: AuthFields): boolean {
  if (mode === 'register') {
    return Boolean(f.name.trim() && f.email.trim() && f.code.trim() && f.password && f.passwordConfirm)
  }
  if (mode === 'reset') return Boolean(f.email.trim() && f.code.trim() && f.password)
  return Boolean(f.email.trim() && f.password)
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
  prefill?: ResetPrefill
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
      // 客户端先行校验：空表单 / 格式 / 密码规则 / 两次不一致都在这里就地报错，不发请求。
      // 命中时只 setError 后 return —— 对话框保持打开，用户能立刻看到原因（#80-1.1）。
      const localErr = clientAuthError(mode, { name, email, code, password, passwordConfirm })
      if (localErr) {
        setNotice(null)
        setError(localErr)
        return
      }
      setError(null)
      setNotice(null)
      setBusy(true)
      try {
        if (mode === 'login') {
          await api.login(email, password)
          router.refresh()
        } else if (mode === 'register') {
          // 服务端错误（验证码无效 / 邮箱已注册…）一律由下面的 catch 落进对话框内的 Alert；
          // 只有成功才 refresh —— 失败路径既不关窗也不吞错（#80-1.1）。
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
          // 深链 query 的清理不在这里：Landing 在**解析出预填值的那一刻**就抹掉了
          //（见 Landing 的 URL 入口 effect）—— 放在这里会漏掉「深链 → 切注册 → 注册成功」这条路径
          //（注册成功后整页换成 Workspace，本弹窗直接卸载，永远走不到这行）。
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

  const switchMode = useCallback(
    (m: Mode) => {
      onModeChange(m)
      setError(null)
      setNotice(null)
      setCodeMsg(null)
      setCooldown(0)
      // #80-1.2：切换视图只保留邮箱。
      // 密码类字段（登录密码 / 新密码 / 注册密码与确认密码）必须清空 —— 否则登录密码会被带进
      // 「找回密码」的新密码框（掩码可见），用户不留意就会把密码重置回同一个旧值；注册侧更直接：
      // 密码被带入旧值、用户只补「确认密码」时极易触发「两次输入的密码不一致」。
      // 昵称与验证码是视图私有字段，一并清掉。
      // 邀请码**例外**：它来自邀请链接（?invite=），属于入口上下文而不是视图字段 ——
      // 清掉会让被邀请人切一次视图就静默丢掉奖励，故保留。
      setPassword('')
      setPasswordConfirm('')
      setName('')
      setCode('')
    },
    [onModeChange]
  )

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
            <Typography type="body-sm" style={{ color: 'var(--muted)' }}>{subtitle}</Typography>

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
                    <Typography type="body-xs" className="mt-1.5" role={codeMsg.kind === 'err' ? 'alert' : 'status'} style={{ color: codeMsg.kind === 'err' ? 'var(--danger-quiet, #b3402e)' : 'var(--muted-strong)' }}>
                      {codeMsg.text}
                    </Typography>
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
                {/* #74-2.1：规则必须在界面上明示，且与注册/改密用的是同一句文案（PASSWORD_RULE_TEXT） */}
                {mode !== 'login' && (
                  <Typography type="body-xs" className="mt-1.5" style={{ color: 'var(--muted)' }}>
                    {PASSWORD_RULE_TEXT}
                  </Typography>
                )}
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

              {/* #74-2.2：必填没填齐就置灰，不再把空表单丢给服务端兜底（登录空提交曾误报「邮箱或密码不正确。」） */}
              <Button
                type="submit"
                variant="primary"
                className="mt-4 w-full"
                isDisabled={busy || !isFormFilled(mode, { name, email, code, password, passwordConfirm })}
              >
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
