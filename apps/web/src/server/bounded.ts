/**
 * 有界并发。独立成模块（不依赖 settings / store / storage）是为了让「纯逻辑」的调用方
 * （如 `storage-migrate.ts` 的搬迁与孤儿清理）也能复用，而不必把应用运行时拖进来。
 */

/**
 * 有界并发地跑一批任务，**全部跑完才 resolve**（前提是 `task` 自己吞掉错误 —— 与
 * `removeFromAllStorages` 的 best-effort 语义一致；若 `task` 抛错，`Promise.all` 会提前
 * reject 并跳过尚未开始的任务）。
 *
 * 抽出来是为了能被断言「并发度真的有界」—— 直接把 `Promise.all` 铺开会把 N 个请求同时
 * 打出去，而串行又慢。
 *
 * ⚠️ `concurrency` 必须是 ≥1 的有限数：`NaN` 会让 `Array.from({length: NaN})` 得到空数组、
 * **静默一个都不跑**（比报错更难查），故这里直接抛。
 */
export async function runBounded<T>(
  items: readonly T[],
  concurrency: number,
  task: (item: T) => Promise<void>
): Promise<void> {
  if (!Number.isFinite(concurrency) || concurrency < 1) {
    throw new RangeError(`runBounded 的并发度必须是 ≥1 的有限数，收到 ${concurrency}`)
  }
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      // JS 单线程：`next++` 是同一个同步表达式里的读+自增，两次 await 之间不会被别的 worker 插进来
      const item = items[next++]
      await task(item)
    }
  }
  const n = Math.min(concurrency, items.length)
  await Promise.all(Array.from({ length: n }, worker))
}
