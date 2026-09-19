'use client'

/**
 * admin 危险操作确认（heroui-migration GDD L2-1）：window.confirm → HeroUI AlertDialog。
 * 承诺：取消 / 关闭键 / 遮罩一律 resolve(false)，绝不触碰调用方请求逻辑；
 * message 由调用方字面量直传，逐字展示（含换行），本层不得改写（契约 D2）。
 * 注意：HeroUI 危险确认默认禁用 Esc 关闭（防误触的组件语义，实测一致），
 * 故 Esc 不在取消路径里；键盘用户走 Tab 到「取消」按钮。
 */
import { AlertDialog, Button } from '@heroui/react'
import { useState } from 'react'

type ConfirmOptions = { title?: string; message: string; confirmLabel?: string }

export function useConfirm() {
  const [state, setState] = useState<(ConfirmOptions & { resolve: (ok: boolean) => void }) | null>(null)

  function confirm(opts: ConfirmOptions): Promise<boolean> {
    return new Promise((resolve) => {
      // 并发防呆：旧未决 promise 按取消收场，防泄漏（评审建议）
      state?.resolve(false)
      setState({ ...opts, resolve })
    })
  }

  const confirmElement = (
    <AlertDialog.Backdrop
      isOpen={state !== null}
      onOpenChange={(open) => {
        if (!open) {
          state?.resolve(false)
          setState(null)
        }
      }}
    >
      <AlertDialog.Container>
        <AlertDialog.Dialog className="sm:max-w-[420px]">
          <AlertDialog.CloseTrigger aria-label="关闭" />
          <AlertDialog.Header>
            <AlertDialog.Icon status="danger" />
            <AlertDialog.Heading>{state?.title ?? '确认操作'}</AlertDialog.Heading>
          </AlertDialog.Header>
          <AlertDialog.Body className="whitespace-pre-line">{state?.message}</AlertDialog.Body>
          <AlertDialog.Footer>
            <Button slot="close" variant="secondary">
              取消
            </Button>
            <Button
              variant="danger"
              onPress={() => {
                const r = state?.resolve
                setState(null)
                r?.(true)
              }}
            >
              {state?.confirmLabel ?? '确认'}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Dialog>
      </AlertDialog.Container>
    </AlertDialog.Backdrop>
  )

  return { confirm, confirmElement }
}
