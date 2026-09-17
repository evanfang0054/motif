import { NextResponse } from 'next/server'
import { CREDIT_PACKAGES } from '@/server/services'
import type { BillingPackagesResponse } from '@motif/core'

export async function GET(): Promise<NextResponse> {
  const body: BillingPackagesResponse = {
    packages: CREDIT_PACKAGES,
    // 本地部署未接入 Stripe：走内置模拟收银台
    configured: false,
  }
  return NextResponse.json(body)
}
