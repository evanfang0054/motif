#!/usr/bin/env node
/**
 * Motif 独立生成队列 worker
 *
 * 用法：pnpm worker
 *
 * 用途：把队列消费从 web 进程拆出去。配合系统设置里把「本进程内运行生成队列 worker」
 * 关掉（`MOTIF_INPROC_WORKER=false`）使用；**两者同时开着也安全** —— 认领走
 * `leaseNextMessage` 的租约语义，同一条消息只会被一个进程拿到，另一个进程那一轮取不到活。
 *
 * ⚠️ 必须先 bootstrapConfig 再 startWorker：配置的真相在 settings 表，不先播种就读不到
 * 库里已改的配置（照抄 apps/web/src/instrumentation.ts 的启动顺序）。
 * ⚠️ 用 tsx 跑而不是裸 node：仓库内部 import 无扩展名（`./services`）且用 `@/` 别名，
 * Node 原生解析不了（实测 `--experimental-strip-types` 也会被 `constructor(readonly x)` 这类
 * 非可擦除语法卡住）。`tsx` 只在 scripts 里用，不进 apps/web 的运行时依赖。
 */
const { bootstrapConfig } = await import('../apps/web/src/server/bootstrap-config.ts')
const { startWorker, stopWorker } = await import('../apps/web/src/server/worker.ts')

const seeded = await bootstrapConfig()
if (seeded.length > 0) console.log(`[motif] 已从环境变量播种 ${seeded.length} 项配置：${seeded.join(', ')}`)

const started = startWorker()
// 开关关着时**立刻退出**：留着不干活会变成僵尸进程，运维会误以为队列有人在消费。
if (!started) process.exit(0)

// startWorker 的轮询定时器是 unref 的（web 进程不该被它拖住事件循环），所以独立进程
// 必须自己撑着 —— 否则 unref 的 interval 不阻塞退出，进程会立刻结束、一条消息都不消费。
const keepAlive = setInterval(() => {}, 1 << 30)

/**
 * 优雅停机：只清定时器，**不等在途批次跑完**。
 * 单批最长 30 分钟（LEASE_MS），等它会让 SIGTERM 迟迟不返回；租约到期后未完成的消息
 * 会被 requeueExpiredLeases 自动重排，故直接退出是安全的（不会丢任务）。
 */
function shutdown(signal) {
  console.log(`[motif] 收到 ${signal}，停止 worker（在途批次将由租约到期后自动重排）`)
  clearInterval(keepAlive)
  stopWorker()
  process.exit(0)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
