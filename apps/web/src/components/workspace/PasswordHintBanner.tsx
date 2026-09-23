'use client'

import { useEffect, useState } from 'react'
import { Button, Modal, Typography } from '@heroui/react'
import { isHintDismissed, markHintDismissed, sessionStore } from '@/lib/password-hint'

/**
 * 强制改密软提示：仅在账号由引导创建或被管理员重置后显示。
 * 刻意不做页面重定向、不拦截 API —— 用户可继续使用，只做提醒。
 *
 * 2026-09-21 裁决（用户）：由顶部横幅改为弹窗。
 * 2026-09-23 批准的设计 **D12**（取代「本机永久不再提醒」的旧口径）：保留全屏弹窗，但
 * 「稍后」写**本次会话**抑制标记（`sessionStorage`），不再定时重弹；首次登录仍弹一次。
 * 抑制的键与读写都在 `@/lib/password-hint`（纯函数 + 单测），这里只负责 UI。
 *
 * ⚠️ 遮罩**不可点背景/Esc 关闭**（`isDismissable={false}` + `isKeyboardDismissDisabled`）：
 * 若把「误点背景」也当成一个出口，用户会在毫不知情的情况下丢掉这条提醒 ——
 * 而这提醒的价值恰恰在于「你现在用的是一串系统随机密码」。故只留「去修改」「稍后」两个明确出口。
 * 「遮罩在屏时拦住画布点击」是模态的**正常行为**，设计 §6.2 明确不单独改 ——
 * 抑制生效后就没有遮罩了，验收项「点『稍后』后画布交互立即可用」即由此成立。
 *
 * ⚠️ 初始态是「不显示」而不是「显示」：storage 只能在 effect 里读（SSR 期不存在），
 * 首帧若按「显示」渲染，已抑制过的用户每次进工作台都会看到弹窗闪一下。
 */
export function PasswordHintBanner({
  show,
  userId,
  onChangePassword,
}: {
  show: boolean
  /** 当前用户 id：用于按账号隔离抑制标记 */
  userId: string
  onChangePassword: () => void
}) {
  /** 本次会话已抑制：默认 true = 不显示，挂载后再读（见文件头注释） */
  const [dismissed, setDismissed] = useState(true)

  useEffect(() => {
    setDismissed(isHintDismissed(sessionStore(), userId))
  }, [userId])

  if (!show || dismissed) return null

  /**
   * 两个出口写**同一个**会话标记：口径是「本次会话抑制」，不按按钮区分持久性
   * （用户点「去修改」也可能只是去看看、并没真改，这次会话内就不该再拿同一件事打扰他）。
   * 顺序：先关掉再写 —— 写失败（隐私模式）不该挡住关闭动作。
   */
  const dismiss = () => {
    setDismissed(true)
    markHintDismissed(sessionStore(), userId)
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
                dismiss()
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
