'use client'

import { useEffect, useState } from 'react'
import { Button, Modal, Typography } from '@heroui/react'

/**
 * 强制改密软提示：仅在账号由引导创建或被管理员重置后显示。
 * 刻意不做页面重定向、不拦截 API —— 用户可继续使用，只做提醒。
 *
 * 2026-09-21 裁决（用户）：① 由顶部横幅改为弹窗；② 点「稍后」之后**本机不再提醒**。
 *
 * 为什么「稍后」记在 localStorage 而不是库里：用户裁决按本机记（不动数据库）。
 * 代价是换浏览器/清缓存后会再提醒一次 —— 这是有意的取舍，不是缺陷。
 *
 * ⚠️ 存储键**按 userId 分**：同一浏览器换账号登录时，A 点过「稍后」不能把 B 的提醒也吞掉。
 *
 * ⚠️ 弹窗**不可点背景/Esc 关闭**（isDismissable={false} + isKeyboardDismissDisabled）：
 * 若把「误点背景」也当成「稍后」，用户会在毫不知情的情况下永久丢掉这条提醒 ——
 * 而这提醒的价值恰恰在于「你现在用的是一串系统随机密码」。故只留「去修改」「稍后」两个明确出口。
 *
 * ⚠️ 初始态是「不显示」而不是「显示」：localStorage 只能在 effect 里读（SSR 期不存在），
 * 首帧若按「显示」渲染，已点过「稍后」的用户每次进工作台都会看到弹窗闪一下。
 */
const STORAGE_PREFIX = 'motif:password-hint-dismissed:'

function dismissKey(userId: string) {
  return `${STORAGE_PREFIX}${userId}`
}

export function PasswordHintBanner({
  show,
  userId,
  onChangePassword,
}: {
  show: boolean
  /** 当前用户 id：用于按账号隔离「已稍后」标记 */
  userId: string
  onChangePassword: () => void
}) {
  /** 本机持久标记（点过「稍后」）：默认 true = 不显示，挂载后再读（见文件头注释） */
  const [dismissedForever, setDismissedForever] = useState(true)
  /** 本次会话已处理过（点过「去修改」或「稍后」）：不再弹回来 */
  const [handled, setHandled] = useState(false)

  useEffect(() => {
    try {
      setDismissedForever(localStorage.getItem(dismissKey(userId)) === '1')
    } catch {
      // 隐私模式下 localStorage 可能抛异常：读不到就按「没点过稍后」处理（照常提醒）
      setDismissedForever(false)
    }
    // 换账号要复位本次会话的处理位（否则切到另一个待改密的账号会被上一次的「稍后」吞掉）
    setHandled(false)
  }, [userId])

  if (!show || dismissedForever || handled) return null

  /** 「稍后」：先关掉再写标记 —— 写 localStorage 在隐私模式下可能抛异常，不能挡住关闭动作 */
  const dismiss = () => {
    setHandled(true)
    try {
      localStorage.setItem(dismissKey(userId), '1')
    } catch {
      // 写不进去就只关掉本次：下次进来还会提醒，属于可接受降级
    }
    setDismissedForever(true)
  }

  return (
    <Modal.Backdrop isOpen isDismissable={false} isKeyboardDismissDisabled>
      <Modal.Container>
        <Modal.Dialog aria-label="修改密码提醒">
          <Modal.Header>
            <Modal.Heading>建议修改密码</Modal.Heading>
          </Modal.Header>
          <Modal.Body>
            <Typography type="body-sm" style={{ color: 'var(--muted)', lineHeight: 1.8 }}>
              当前密码由系统生成，建议立即修改为自己的密码。
            </Typography>
          </Modal.Body>
          <Modal.Footer>
            <Button variant="secondary" onPress={dismiss}>
              稍后
            </Button>
            {/* 必须先关弹窗再开个人资料弹窗：两个 Modal 同时开时焦点陷阱会互相打架 */}
            <Button
              variant="primary"
              onPress={() => {
                setHandled(true)
                onChangePassword()
              }}
            >
              去修改
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  )
}
