/**
 * 启动时的配置播种步骤。
 *
 * ⚠️ **刻意独立成一个模块，而不是放在 `instrumentation.ts` 里。**
 * `instrumentation.ts` 会被 Next 同时按 nodejs 与 edge 两个运行时编译；放在它顶层的
 * 导出函数体（哪怕里面只写 `await import(...)`）会让 edge 那份编译也去追
 * `context.ts → @motif/db → better-sqlite3 → bindings → fs` 这条链，而 edge 里没有 `fs`，
 * 于是 dev 编译直接失败、所有路由 500（生产构建不受影响，所以只跑 build 发现不了）。
 * 放在单独模块里、由 `register()` 在 `NEXT_RUNTIME === 'nodejs'` 分支内动态 import，
 * 这条链就不会进入 edge 的模块图。
 *
 * 返回本次新播种的键；返回空数组表示要么没有可播的值，要么已全部播过。
 */
export async function bootstrapConfig(): Promise<string[]> {
  const { getRuntime, invalidateRuntime } = await import('./context')
  const { seedSettings } = await import('./settings')
  const { store } = getRuntime()
  const seeded = seedSettings(store, process.env)
  if (seeded.length > 0) {
    // 播种改变了配置来源（环境变量 → 数据库），重建 provider / mailer 让本次启动就走库里的值
    invalidateRuntime()
  }
  return seeded
}
