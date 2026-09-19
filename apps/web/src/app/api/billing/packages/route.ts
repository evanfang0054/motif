import { NextResponse } from 'next/server'
import { getRuntime } from '@/server/context'
import { resolvePackages } from '@/server/services'
import type { BillingPackagesResponse } from '@motif/core'

export async function GET(): Promise<NextResponse> {
  const { store } = getRuntime()
  const body: BillingPackagesResponse = {
    packages: resolvePackages(store, process.env),
    // 本地部署未接入真实支付渠道：走内置模拟收银台（渠道配置见管理后台危险区）
    configured: false,
  }
  return NextResponse.json(body)
}
