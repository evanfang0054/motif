'use client'

import { useEffect, useState } from 'react'
import { api, type PublicConfig } from './client'

/**
 * 公开配置的模块级缓存：同一页面内多个组件（邀请入口、邀请弹窗、注册页）共用一次请求。
 * 失败时不写入缓存，下次挂载会重试。
 */
let cached: PublicConfig | null = null
let inflight: Promise<PublicConfig> | null = null

function load(): Promise<PublicConfig> {
  if (cached) return Promise.resolve(cached)
  inflight ??= api.publicConfig().then((c) => {
    cached = c
    return c
  })
  return inflight
}

/**
 * 读公开配置。首帧返回 `null`（尚未取到），**调用方必须对 null 做保守处理**：
 * 入口按「不渲染」、文案按「不写数字」—— 显示错的数字比不显示更糟。
 */
export function usePublicConfig(): PublicConfig | null {
  const [cfg, setCfg] = useState<PublicConfig | null>(cached)
  useEffect(() => {
    let alive = true
    void load()
      .then((c) => {
        if (alive) setCfg(c)
      })
      .catch(() => {
        // 取不到就维持 null：按保守默认渲染，不阻断页面
        inflight = null
      })
    return () => {
      alive = false
    }
  }, [])
  return cfg
}
