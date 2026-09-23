import type { NextConfig } from 'next'
import path from 'node:path'

const nextConfig: NextConfig = {
  // monorepo 场景锁定 tracing root，避免 HOME 下杂散 lockfile 干扰 workspace 推断
  outputFileTracingRoot: path.join(__dirname, '../..'),
  serverExternalPackages: ['better-sqlite3', 'sharp'],
  transpilePackages: ['@motif/core', '@motif/db', '@motif/image-provider'],
}

export default nextConfig
