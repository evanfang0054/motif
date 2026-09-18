/**
 * 启动时的配置播种步骤。
 *
 * 独立成导出函数（而不是内联在 register 里）是为了可测：「空库首次启动后 settings 表
 * 含由环境变量播种的键」这句要求，只有在能真的执行「启动那一步」时才验证得了 ——
 * 单测不会去加载 instrumentation.ts。
 *
 * 返回本次新播种的键；返回空数组表示要么没有可播的值，要么已全部播过。
 */
export async function bootstrapConfig(): Promise<string[]> {
  const { getRuntime, invalidateRuntime } = await import('./server/context')
  const { seedSettings } = await import('./server/settings')
  const { store } = getRuntime()
  const seeded = seedSettings(store, process.env)
  if (seeded.length > 0) {
    // 播种改变了配置来源（环境变量 → 数据库），重建 provider / mailer 让本次启动就走库里的值
    invalidateRuntime()
  }
  return seeded
}

/**
 * Next.js 服务启动钩子：进程拉起时执行配置播种、启动生成队列 worker、并执行管理员引导。
 * globalThis 单例守卫保证 dev 热重载 / 路由懒启动双路径下只有一份 worker。
 *
 * 关键：每个子步骤都必须各自包 try/catch，任一步失败都不阻断进程启动。
 * 播种与失效重建放在启 worker 之前，是为了让 worker 第一次 tick 就用上库里的配置。
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // 配置播种：把环境变量写进 settings 表（只写不存在的键），此后以库为唯一真相
    try {
      const seeded = await bootstrapConfig()
      if (seeded.length > 0) {
        console.log(`[motif] 已从环境变量播种 ${seeded.length} 项配置：${seeded.join(', ')}`)
      }
    } catch (e) {
      console.error('[motif] 配置播种未执行（将回退到环境变量，不影响进程启动）:', e)
    }

    const { startWorker } = await import('./server/worker')
    try {
      startWorker()
    } catch (e) {
      console.error('[motif] 启动队列 worker 失败（将在首个生图请求时重试懒启动）:', e)
    }

    // 管理员引导：库中尚无 root 时创建并交付随机强密码（幂等；异常不阻断启动）
    try {
      const { ensureRootAccount } = await import('./server/bootstrap')
      const { getRuntime } = await import('./server/context')
      const { store, dataDir } = getRuntime()
      ensureRootAccount({ store, dataDir, env: process.env })
    } catch (e) {
      console.error('[motif] 管理员引导未执行（不影响进程启动；可用 pnpm admin:reset 补建）:', e)
    }
  }
}
