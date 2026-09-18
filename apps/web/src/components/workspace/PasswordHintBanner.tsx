'use client'

/**
 * 强制改密软提示：仅在账号由引导创建或被管理员重置后显示。
 * 刻意不做页面重定向、不拦截 API —— 用户可继续使用，只做提醒。
 */
export function PasswordHintBanner({
  show,
  onChangePassword,
  onDismiss,
}: {
  show: boolean
  onChangePassword: () => void
  onDismiss: () => void
}) {
  if (!show) return null
  return (
    <div className="ws-password-hint" role="status">
      <span className="ws-password-hint-text">当前密码由系统生成，建议立即修改为自己的密码。</span>
      <div className="ws-password-hint-actions">
        <button type="button" className="ws-password-hint-primary" onClick={onChangePassword}>
          去修改
        </button>
        <button type="button" className="ws-password-hint-dismiss" onClick={onDismiss} aria-label="关闭提示">
          稍后
        </button>
      </div>
    </div>
  )
}
