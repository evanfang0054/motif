import { NextRequest, NextResponse } from 'next/server'
import { writeAudit } from '@/server/admin'
import { getRuntime } from '@/server/context'
import { resolveSetting } from '@/server/settings'
import { verifyEpayNotify } from '@/server/payment/epay'
import { creditPaidOrder } from '@/server/services'
import { checkRate } from '@/server/rate-limit'

/**
 * 易支付异步通知（网关服务器 → 我们）：
 * 频控 → 验签 → 成功态过滤 → 金额核对幂等入账 → 纯文本 success/fail（HTTP 200，网关以正文判重试，对齐 new-api）。
 * 公开端点先频控再验签：防垃圾流量灌爆审计表（better-sqlite3 同步写会拖慢事件循环）。
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  return handle(req)
}
export async function GET(req: NextRequest): Promise<NextResponse> {
  return handle(req)
}

function clientIp(req: NextRequest): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local'
}

async function handle(req: NextRequest): Promise<NextResponse> {
  const { store } = getRuntime()
  const ip = clientIp(req)
  if (!checkRate(`notify:ip:${ip}`, 60_000, 60)) return new NextResponse('fail')

  const key = resolveSetting(store, process.env, 'EPAY_KEY')
  const text = await req.text()
  const params: Record<string, string> = Object.fromEntries(new URL(req.url).searchParams)
  for (const [k, v] of new URLSearchParams(text)) if (!params[k]) params[k] = v // GET query / POST form 双形态

  if (!key || !verifyEpayNotify(params, key).ok) {
    // 审计降噪：仅当订单号命中「存在的 pending 订单」才入库（真实伪造线索），垃圾流量只进服务端日志
    const suspect = params.out_trade_no ? store.getOrder(params.out_trade_no) : undefined
    if (suspect?.status === 'pending') {
      writeAudit({
        actorId: 'system',
        action: 'billing.notify_rejected',
        targetType: 'order',
        targetId: params.out_trade_no,
        detail: { channel: 'epay', reason: 'bad_sign', ip },
      })
    } else {
      console.warn(`[billing] epay notify 验签失败已忽略 ip=${ip}`)
    }
    return new NextResponse('fail')
  }
  if (params.trade_status !== 'TRADE_SUCCESS') return new NextResponse('success') // 非成功态：确认收到，停止重发
  const result = creditPaidOrder(store, params.out_trade_no ?? '', Math.round(Number(params.money) * 100))
  if (result === 'not_found') {
    writeAudit({
      actorId: 'system',
      action: 'billing.notify_rejected',
      targetType: 'order',
      targetId: params.out_trade_no ?? null,
      detail: { channel: 'epay', reason: 'order_not_found', ip },
    })
    return new NextResponse('fail') // 让网关按策略重试
  }
  if (result === 'mismatch') {
    writeAudit({
      actorId: 'system',
      action: 'billing.notify_rejected',
      targetType: 'order',
      targetId: params.out_trade_no ?? null,
      detail: { channel: 'epay', reason: 'amount_mismatch', money: params.money, ip },
    })
    return new NextResponse('fail')
  }
  return new NextResponse('success') // ok 与 duplicate 都回 success 停止重试
}
