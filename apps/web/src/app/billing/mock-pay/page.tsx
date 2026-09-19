'use client'

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Alert, Button, Card } from '@heroui/react'
import { api } from '@/lib/client'
import { BrandMark } from '@/components/BrandMark'
import { anchorRender } from '@/components/ui/anchor-button'

/** 模拟收银台页面（本地部署；线上版由 Stripe Checkout 承担） */

/**
 * 模拟收银台组件
 *
 * 用于本地部署的模拟支付页面，提供支付流程的状态管理和 UI 展示。
 * 从 URL 参数中获取订单 ID，执行模拟支付操作，并根据支付结果显示不同的状态界面。
 *
 * @returns JSX 元素
 */
function PayPanel() {
  const params = useSearchParams()
  const orderId = params.get('order') ?? ''
  const [state, setState] = useState<'ready' | 'paying' | 'done' | 'error'>('ready')
  const [message, setMessage] = useState('')

  const pay = async () => {
    setState('paying')
    try {
      const res = await api.mockPay(orderId)
      setState('done')
      setMessage(`支付成功，已充值 ${res.paid} 张额度。`)
    } catch (e) {
      setState('error')
      setMessage(e instanceof Error ? e.message : '支付失败')
    }
  }

  return (
    <Card className="p-6" style={{ width: 'min(420px, 100%)', textAlign: 'center' }}>
      <div className="flex items-center justify-center gap-2">
        <BrandMark />
        <b>Motif 模拟收银台</b>
      </div>
      <p className="mt-3 text-sm" style={{ color: 'var(--muted)' }}>
        订单号：{orderId || '（缺失）'}
        <br />
        这是本地部署使用的模拟支付页面，不会产生真实扣款。
      </p>
      {state === 'done' ? (
        <>
          <Alert status="success" className="mt-4">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>{message}</Alert.Title>
            </Alert.Content>
          </Alert>
          <Button variant="primary" className="mt-4" render={anchorRender({ href: '/' })}>返回工作台</Button>
        </>
      ) : (
        <>
          {state === 'error' && (
            <Alert status="danger" className="mt-4">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Title>{message}</Alert.Title>
              </Alert.Content>
            </Alert>
          )}
          <Button variant="primary" className="mt-4 w-full" isDisabled={state !== 'ready' || !orderId} onPress={() => void pay()}>
            {state === 'paying' ? '支付中…' : '确认支付'}
          </Button>
          <Button variant="ghost" className="mt-2 w-full" render={anchorRender({ href: '/' })}>取消并返回</Button>
        </>
      )}
    </Card>
  )
}

export default function MockPayPage() {
  return (
    <div className="pay-page">
      <Suspense fallback={null}>
        <PayPanel />
      </Suspense>
    </div>
  )
}
