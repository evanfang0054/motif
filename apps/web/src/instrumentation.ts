/**
 * Next.js 服务启动钩子：进程拉起时自动启动生成队列 worker，
 * 恢复历史 queued 消息并重排崩溃遗留的过期租约（Issue #4）。
 * globalThis 单例守卫保证 dev 热重载 / 路由懒启动双路径下只有一份 worker。
 * 缺生图配置时降级为日志告警（保持旧行为：请求路径懒启动时才报错），不让进程起不来。
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startWorker } = await import('./server/worker')
    try {
      startWorker()
    } catch (e) {
      console.error('[motif] 启动队列 worker 失败（将在首个生图请求时重试懒启动）:', e)
    }
  }
}
