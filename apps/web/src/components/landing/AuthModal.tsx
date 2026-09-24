'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Alert, Button, Input, InputGroup, Label, Link, Modal as HeroModal, TextField, Typography } from '@heroui/react'
import { Eye, EyeSlash, PaperPlane } from '@gravity-ui/icons'
import { PASSWORD_RULE_TEXT } from '@motif/core'
import { IconButton } from '@/components/ui/icon-button'
import { api } from '@/lib/client'
import { clientAuthError, isFormFilled, switchAuthFields, type AuthMode } from '@/lib/auth-form'
import { errorMessage } from '@/lib/error-message'
import { usePublicConfig } from '@/lib/use-public-config'
import type { ResetPrefill } from '@/lib/reset-link'

/** 当前视图（三种视图共用同一个弹窗，值由 Landing 持有） */
type Mode = AuthMode

const RESEND_COOLDOWN = 60

/** 发送验证码前的邮箱形状预检：只判「像不像邮箱」，用于把反馈落在手指附近（提交路径走 core 的 validateEmail） */
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

  const switchMode = useCallback(
    (m: Mode) => {
      onModeChange(m)
      setError(null)
      setNotice(null)
      setCodeMsg(null)
      setCooldown(0)
      // #80-1.2：切换视图只保留邮箱与邀请码 —— 清空规则集中在 lib/auth-form 的 switchAuthFields（可单测）
      const next = switchAuthFields({ name, email, code, password, passwordConfirm, inviteCode }, m)
      setName(next.name)
      setEmail(next.email)
      setCode(next.code)
      setPassword(next.password)
      setPasswordConfirm(next.passwordConfirm)
      setInviteCode(next.inviteCode)
    },
    [onModeChange, name, email, code, password, passwordConfirm, inviteCode]
  )

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
          // #80-1.2 同类泄漏：重置成功切回登录视图也必须清掉密码类字段（否则登录框会带着刚设置的新密码）。
          // 但 switchMode 内部会先 setNotice(null)，所以成功提示必须落在它**之后** —— 顺序反了就看不到提示。
          switchMode('login')
          setNotice('密码已重置，请用新密码登录。')
          // 深链 query 的清理不在这里：Landing 在**解析出预填值的那一刻**就抹掉了
          //（见 Landing 的 URL 入口 effect）—— 放在这里会漏掉「深链 → 切注册 → 注册成功」这条路径
          //（注册成功后整页换成 Workspace，本弹窗直接卸载，永远走不到这行）。
        }
      } catch (err) {
        setError(errorMessage(err, '操作失败，请重试。'))
      } finally {
        setBusy(false)
      }
    },
    [mode, name, email, code, password, passwordConfirm, inviteCode, router, switchMode]
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
      setCodeMsg({ kind: 'err', text: errorMessage(err, '发送失败') })
    }
  }, [mode, email, cooldown, startCooldown])

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
      /*
       * 认证弹窗**不允许**点背景关闭（HeroUI 的 Backdrop 默认 isDismissable=true）。
       * 为什么：矮视口（如 1280×633）下弹窗内容会内部滚动、提交按钮紧贴外框留白，用户「点按钮」极易点空
       * 而落在遮罩上 —— 默认行为会把整个弹窗静默关掉，已填的邮箱 / 密码 / 验证码全丢且没有任何提示
       *（#80-1.1 的真因）。宁可让这次点击变成空操作，也不能静默丢掉用户已填的表单。
       * Esc 仍然可以关闭（**不**设 isKeyboardDismissDisabled）：键盘用户需要一个确定的逃生口，
       * 且 Esc 是有意为之的操作，不会被误当成「点了提交却没反应」。
       */
      isDismissable={false}
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

            <form id="auth-form" onSubmit={submit} className="mt-2">
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
            </form>
          </HeroModal.Body>

          {/*
           * 主操作按钮与「注册 / 登录 / 忘记密码」切换链接放在 Footer 而不是可滚动的 Body 里（#80-1.1）。
           * 为什么：矮视口下 Body 会内部滚动，按钮留在 Body 里会被裁到折叠线以下 —— 用户点不到或点空，
           * 表现为「点了没反应」。Footer 常驻在滚动区之外，三种视图（login / register / reset）都受益。
           * 按钮与表单分离后靠 `form` 属性关联：`form="auth-form"` 让原生按钮仍是该表单的
           * default button，所以**回车提交**与 `type="submit"` 的隐式提交行为都不受影响。
           */}
          <HeroModal.Footer>
            <div className="w-full">
              {/* #74-2.2：必填没填齐就置灰，不再把空表单丢给服务端兜底（登录空提交曾误报「邮箱或密码不正确。」） */}
              <Button
                type="submit"
                form="auth-form"
                variant="primary"
                className="w-full"
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
            </div>
          </HeroModal.Footer>
        </HeroModal.Dialog>
      </HeroModal.Container>
    </HeroModal.Backdrop>
  )
}

export { AuthModal }
export type { Mode }
