/**
 * Next.js 服务启动钩子：进程拉起时启动生成队列 worker 并执行管理员引导。
 * globalThis 单例守卫保证 dev 热重载 / 路由懒启动双路径下只有一份 worker。
 *
 * 关键：两个子步骤都必须包 try/catch。getRuntime() 在缓存未命中时会构造生图 provider，
 * 而 provider 在缺少 IMAGE_API_BASE_URL / IMAGE_API_KEY 时**会抛错**；
 * 若不包裹，缺配置的部署会直接起不来 —— 这正是本文件此前刻意规避的行为。
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
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
