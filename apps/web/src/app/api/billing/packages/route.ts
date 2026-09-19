import { NextResponse } from 'next/server'
import { getRuntime } from '@/server/context'
import { paymentChannel, resolvePackages } from '@/server/services'
import type { BillingPackagesResponse } from '@motif/core'

export async function GET(): Promise<NextResponse> {
  const { store } = getRuntime()
  const body: BillingPackagesResponse = {
    packages: resolvePackages(store, process.env),
    channel: paymentChannel(store),
    // configured 语义：后台已可出套餐（价格有默认回退，恒可展示）；真实渠道就绪与否看 health 与 channel
    configured: true,
  }
  return NextResponse.json(body)
}
