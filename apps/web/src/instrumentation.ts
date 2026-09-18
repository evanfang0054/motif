/**
 * Next.js 服务启动钩子：进程拉起时执行配置播种、启动生成队列 worker、并执行管理员引导。
 * globalThis 单例守卫保证 dev 热重载 / 路由懒启动双路径下只有一份 worker。
 *
 * 关键：每个子步骤都必须各自包 try/catch，任一步失败都不阻断进程启动。
 * 播种与失效重建放在启 worker 之前，是为了让 worker 第一次 tick 就用上库里的配置。
 *
 * ⚠️ 所有 node-only 的模块一律在 `NEXT_RUNTIME === 'nodejs'` 分支内**动态 import**，
 * 且不要在顶层导出任何会牵连它们的函数。本文件会被 Next 同时按 nodejs 与 edge 两个运行时
 * 编译，edge 里没有 `fs`；一旦这条链进入 edge 的模块图，dev 编译就会失败、所有路由 500
 * （而生产构建照样通过，只跑 build 发现不了）。播种步骤因此放在 ./server/bootstrap-config。
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // 配置播种：把环境变量写进 settings 表（只写不存在的键），此后以库为唯一真相
    try {
      const { bootstrapConfig } = await import('./server/bootstrap-config')
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
