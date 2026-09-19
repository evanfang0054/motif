'use client'

import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Alert, Button, Card } from '@heroui/react'
import { api, ApiError } from '@/lib/client'
import { BrandMark } from '@/components/BrandMark'
import { anchorRender } from '@/components/ui/anchor-button'

const MAX_POLLS = 100 // 100 × 3s ≈ 5 分钟上限，超时转终态文案（网关回调迟到不该让用户干等）

function Panel() {
  const search = useSearchParams()
  const orderId = search.get('order') ?? ''
  const canceled = search.get('canceled') === '1'
  const [state, setState] = useState<'pending' | 'paid' | 'canceled' | 'error'>(canceled ? 'canceled' : orderId ? 'pending' : 'error')
  const [credits, setCredits] = useState<number | null>(null)
  const [errText, setErrText] = useState(orderId ? '' : '链接缺少订单号，请从工作台重新发起充值。')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dead = useRef(false) // StrictMode 双挂载防护：cleanup 置位后，在途回调全部自弃

  const query = useCallback(
    async (attempt: number) => {
      if (dead.current) return
      try {
        const r = await api.billingOrderStatus(orderId)
        if (dead.current) return
        if (r.status === 'paid') {
          setState('paid')
          setCredits(r.credits ?? null)
          return
        }
        if (attempt + 1 >= MAX_POLLS) {
          setState('error')
          setErrText('长时间未确认到账。可稍后在工作台查看额度；若已扣款请联系站点管理员。')
          return
        }
        timer.current = setTimeout(() => {
          if (!dead.current) void query(attempt + 1)
        }, 3000)
      } catch (e) {
        if (dead.current) return
        setState('error')
        setErrText(
          e instanceof ApiError && e.status === 401
            ? '登录已过期，请重新登录后回到本页（已支付额度不丢）。'
            : '订单不存在或查询失败。'
        )
      }
    },
    [orderId]
  )

  useEffect(() => {
    if (state !== 'pending' || !orderId) return
    dead.current = false
    void query(0)
    return () => {
      dead.current = true
      if (timer.current) clearTimeout(timer.current)
    }
  }, [state, orderId, query])

  return (
    <Card className="p-6" style={{ width: 'min(420px, 100%)', textAlign: 'center' }}>
      <div className="flex items-center justify-center gap-2"><BrandMark /><b>支付结果</b></div>
      {state === 'pending' && (
        <p className="mt-3 text-sm" role="status" aria-live="polite">
          <span className="pay-pulse" /> 支付处理中，到账后本页自动更新…
        </p>
      )}
      {state === 'paid' && (
        <Alert status="success" className="mt-4">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{`支付成功，已充值 ${credits ?? '—'} 张额度。`}</Alert.Title>
          </Alert.Content>
        </Alert>
      )}
      {state === 'canceled' && (
        <Alert className="mt-4">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>你已取消支付，未产生扣款。</Alert.Title>
          </Alert.Content>
        </Alert>
      )}
      {state === 'error' && (
        <Alert status="danger" role="alert" className="mt-4">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{errText}</Alert.Title>
            <Button size="sm" variant="outline" className="mt-2" onPress={() => { setErrText(''); setState('pending') }}>重新查询</Button>
          </Alert.Content>
        </Alert>
      )}
      <Button variant="primary" className="mt-4 self-center" render={anchorRender({ href: '/' })}>返回工作台</Button>
    </Card>
  )
}

export default function ResultPage() {
  return (
    <div className="pay-page">
      <Suspense fallback={null}><Panel /></Suspense>
    </div>
  )
}
