/**
 * 通用错误文案入口：把任意抛出物转成**中文**可展示文案。
 *
 * 为什么不能直接用 `e instanceof Error ? e.message`：
 * 离线 / 网络中断时 `fetch` 直接 reject，抛出的是**浏览器英文原文**
 * （Chrome / Firefox：`TypeError: Failed to fetch`；Safari：`Load failed`），
 * 按 `instanceof Error` 透传会把英文原文弹进 toast 或内联错误，违反 CLAUDE.md 的
 * 「UI 文案一律中文」。
 *
 * 判据：**message 含中文才透传，否则回落调用方按场景给的中文兜底**。
 *
 * 为什么不是「只认 `ApiError` 才透传」——本仓有**两类**中文 message 都属于「面向用户的原因」，
 * 只认 `ApiError` 会把它们一并换成泛化兜底（属于「改是改了、语义没达成」）：
 *  ① `ApiError`：服务端 `ServiceError` 的文案本就是中文（如「邮箱或密码不正确。」）；
 *  ② 纯函数 / 裸 fetch 故意抛出的中文 `Error`：
 *     - 画布归档解析（`lib/zip` / `lib/canvas/archive` / `lib/canvas/serialization`）：
 *       「导入失败：不是画布归档（缺少 canvas.json）。」「读取失败：不是合法的 zip…」；
 *     - 画布导出取图失败：`new Error('导出失败：有图片取不到（HTTP N）。')`；
 *     - 参考图上限 / 未建任务：`new Error('参考图最多 N 张…')`、`new Error('请先新建一个任务')`；
 *     - 裸 `fetch` 手写解析的路径（个人资料、改密、发验证码、重置密码）：
 *       `throw new Error(data.error || '保存失败')`。
 *   这些具体原因必须让用户看到，而它们都不是 `ApiError`。
 *
 * 挡英文是目的：英文 message（浏览器原文、框架默认的 `Unauthorized` / `Forbidden`）对用户
 * 毫无意义，一律换成调用方给的中文兜底。
 *
 * 与 `lib/admin-error.ts` 的 `describeAdminError` 的分工：
 *  - 本函数是**通用**入口，兜底文案由调用方按场景给（「支付失败」「兑换失败」…）；
 *  - 管理端还需要按状态码分级（401 引导重新登录、403 给权限指引），且管理页**只调 `api.*`**，
 *    非 `ApiError` 的抛出必然是传输层故障（离线 / DNS / CORS），一律归为「网络异常」——
 *    那层管理端特有的策略留在 `describeAdminError`，它复用本函数处理 `ApiError` 分支。
 */
export function errorMessage(e: unknown, fallback: string): string {
  if (e instanceof Error && hasChinese(e.message)) return e.message
  return fallback
}

/** 文案里是否含中日韩统一表意文字 —— 用来区分「面向用户的中文文案」与「框架 / 浏览器英文原文」 */
function hasChinese(s: string): boolean {
  return /[\u4e00-\u9fff]/.test(s)
}
