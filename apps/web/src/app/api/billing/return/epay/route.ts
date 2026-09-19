import { NextRequest, NextResponse } from 'next/server'

/** 易支付同步返回：用户支付完浏览器跳回 → 落到结果页（order 参数编码防注入；目标恒为站内路径，无开放重定向） */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const order = new URL(req.url).searchParams.get('out_trade_no') ?? ''
  return NextResponse.redirect(new URL(`/billing/result?order=${encodeURIComponent(order)}`, req.url))
}
