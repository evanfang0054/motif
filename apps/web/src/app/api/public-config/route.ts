import { NextResponse } from 'next/server'
import { getRuntime } from '@/server/context'
import { readPublicConfig } from '@/server/public-config'

/**
 * 公开配置：**无需登录**。
 *
 * 注册页在未登录状态下就要显示「注册即送 N 张」，工作台的邀请入口也要按开关显隐，
 * 故这个端点不能走 requireAdmin/requireUser。代价是它对外可见，因此
 * 只回 `PUBLIC_CONFIG_KEYS` 白名单里的非密钥值，绝不回密钥或内部地址。
 */
export async function GET(): Promise<NextResponse> {
  const { store } = getRuntime()
  return NextResponse.json(readPublicConfig(store, process.env))
}
