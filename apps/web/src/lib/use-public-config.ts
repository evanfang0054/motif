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

/**
 * 与 `usePublicConfig` 同源（同一份模块级缓存、同一次请求），但额外给出**是否已定局**：
 * 取到值（`settled: true`）或明确失败（`settled: true, cfg: null`）都算定局。
 *
 * 为什么需要：落地页的**深链** effect（`?reset=…` / `?invite=…` / `?mode=…`）必须等配置到位才能
 * 决定落哪个视图 —— 否则关停了注册的站点会先落注册视图、配置到达后才改回登录，用户看得见这次闪跳。
 * 但「等」不能是无限期：请求失败时 `usePublicConfig` 的 `cfg` **永远**是 null，深链就静默失效 ——
 * 其中 `?reset=1&email=…&code=…` 是被锁在门外的用户**唯一**的恢复路径。
 * 有了 `settled`，调用方就能区分「还没到」与「不会到了」，后者按服务端默认值继续走。
 */
export function usePublicConfigSettled(): { cfg: PublicConfig | null; settled: boolean } {
  const [state, setState] = useState<{ cfg: PublicConfig | null; settled: boolean }>(() =>
    cached ? { cfg: cached, settled: true } : { cfg: null, settled: false },
  )
  useEffect(() => {
    let alive = true
    void load()
      .then((c) => {
        if (alive) setState({ cfg: c, settled: true })
      })
      .catch(() => {
        // 失败也算定局：按保守默认渲染，但不再让深链无限期等着
        inflight = null
        if (alive) setState({ cfg: null, settled: true })
      })
    return () => {
      alive = false
    }
  }, [])
  return state
}
