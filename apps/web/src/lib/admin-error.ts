import { ApiError } from './client'
import { errorMessage } from './error-message'

/**
 * 管理端错误文案统一入口。
 *
 * 为什么不能直接用 `e instanceof Error ? e.message`：
 *  - 网络层失败抛的是**浏览器英文原文**（`TypeError: Failed to fetch`），弹给运营毫无意义；
 *  - 会话失效时接口回 401/403，响应体可能是框架默认的英文（`Forbidden`），原样透出等于没说；
 *  - 「登录已过期」是可行动的（去重新登录），「请求失败（401）」不是。
 *
 * 与通用 `errorMessage` 的分工（后者只做「message 含中文才透传」）：
 *  - 本函数额外按**状态码分级**：401 无中文原因时给「登录已过期」、403 给权限指引，
 *    其它状态码给「请求失败（N）」—— 这些是管理端特有的可行动文案，通用入口给不出；
 *  - 管理页**只调 `api.*`**，非 `ApiError` 的抛出必然是传输层故障（离线 / DNS / CORS），
 *    故一律归为「网络异常」；通用入口不能这么判 —— 非管理端的调用方还会解析本地 zip、
 *    做裸 `fetch`，它们故意抛的中文 `Error` 是要给用户看的（详见 `error-message.ts`）。
 *    故这里**不**把非 `ApiError` 的 Error 交给 `errorMessage`，而是自己给「网络异常」。
 *
 * 401 的处理与其它状态码一致（先看有没有中文），只在**没有中文时**才用「登录已过期」兜底：
 * 「未登录」与「登录已过期」不是一回事，无条件改写会把服务端更准确的原因（如「请先登录。」）
 * 换成一句并不总成立的话 —— 这里是通用入口，任何调用方都会受影响。
 */
export function describeAdminError(e: unknown): string {
  if (e instanceof ApiError) {
    // `errorMessage` 在 message 含中文时透传服务端的具体原因，否则回落下面按状态码给的中文兜底
    return errorMessage(e, adminFallbackForStatus(e.status))
  }
  if (e instanceof Error) return '网络异常，请检查网络后重试。'
  return '操作失败，请稍后重试。'
}

/** 没有中文原因时，按状态码给的可行动中文兜底 */
function adminFallbackForStatus(status: number): string {
  if (status === 401) return '登录已过期，请重新登录。'
  if (status === 403) return '当前账号没有权限访问该功能，请用更高权限的账号登录。'
  return `请求失败（${status}），请稍后重试。`
}
