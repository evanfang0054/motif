'use client'

import { Alert, Button } from '@heroui/react'

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
    <Alert role="status">
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Title>当前密码由系统生成，建议立即修改为自己的密码。</Alert.Title>
        <div className="mt-2 flex gap-2">
          <Button size="sm" variant="primary" onPress={onChangePassword}>
            去修改
          </Button>
          <Button size="sm" variant="secondary" onPress={onDismiss} aria-label="关闭提示">
            稍后
          </Button>
        </div>
      </Alert.Content>
    </Alert>
  )
}
