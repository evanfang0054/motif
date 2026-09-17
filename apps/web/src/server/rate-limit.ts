/**
 * 进程内滑动窗口限流器（单实例部署足够；多实例部署应换共享存储实现）。
 */
const buckets = new Map<string, number[]>()

let lastCleanup = Date.now()

function cleanup(now: number): void {
  if (now - lastCleanup < 60_000) return
  lastCleanup = now
  for (const [key, stamps] of buckets) {
    const alive = stamps.filter((t) => now - t < 3_600_000)
    if (alive.length === 0) buckets.delete(key)
    else buckets.set(key, alive)
  }
}

/** 窗口期内超过 max 次则返回 false */
export function checkRate(key: string, windowMs: number, max: number): boolean {
  const now = Date.now()
  cleanup(now)
  const stamps = (buckets.get(key) ?? []).filter((t) => now - t < windowMs)
  if (stamps.length >= max) return false
  stamps.push(now)
  buckets.set(key, stamps)
  return true
}

/** 测试辅助：清空所有限流状态 */
export function resetRateLimiter(): void {
  buckets.clear()
}
