import type { NextConfig } from 'next'
import path from 'node:path'

const nextConfig: NextConfig = {
  // monorepo 场景锁定 tracing root，避免 HOME 下杂散 lockfile 干扰 workspace 推断
  outputFileTracingRoot: path.join(__dirname, '../..'),
  serverExternalPackages: ['better-sqlite3', 'sharp'],
  transpilePackages: ['@motif/core', '@motif/db', '@motif/image-provider'],
  // dev 下 Next 默认把闲置 60s 的路由条目回收，下次访问它会触发 client/server/edge
  // 三个编译器全量重编译（实测单次占 1.5~1.8 核、耗时数秒到 30s+）。调到 1 小时，
  // 避免来回切页面就重编译。仅 webpack 模式生效，Turbopack 会忽略此配置。
  onDemandEntries: { maxInactiveAge: 60 * 60 * 1000 },
}

export default nextConfig
