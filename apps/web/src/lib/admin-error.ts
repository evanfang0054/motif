import { ApiError } from './client'

/**
 * 管理端错误文案统一入口。
 *
 * 为什么不能直接用 `e instanceof Error ? e.message`：
 *  - 网络层失败抛的是**浏览器英文原文**（`TypeError: Failed to fetch`），弹给运营毫无意义；
 *  - 会话失效时接口回 401/403，响应体可能是框架默认的英文（`Forbidden`），原样透出等于没说；
 *  - 「登录已过期」是可行动的（去重新登录），「请求失败（401）」不是。
 *
 * 判据：`ApiError` 的文案来自服务端 `ServiceError`，本就是中文；**只有中文文案才放行**，
 * 其余（英文原文 / 空串）一律换成中文兜底。这样既保留服务端的具体原因（如「管理员不可
 * 调整超级管理员的额度。」），又不会把框架英文透给用户。
 *
 * 401 的处理与其它状态码一致（先看有没有中文），只在**没有中文时**才用「登录已过期」兜底：
 * 「未登录」与「登录已过期」不是一回事，无条件改写会把服务端更准确的原因（如「请先登录。」）
 * 换成一句并不总成立的话 —— 这里是通用入口，任何调用方都会受影响。
 */
export function describeAdminError(e: unknown): string {
  if (e instanceof ApiError) {
    if (hasChinese(e.message)) return e.message
    if (e.status === 401) return '登录已过期，请重新登录。'
    if (e.status === 403) return '当前账号没有权限访问该功能，请用更高权限的账号登录。'
    return `请求失败（${e.status}），请稍后重试。`
  }
  if (e instanceof Error) return '网络异常，请检查网络后重试。'
  return '操作失败，请稍后重试。'
}

/** 文案里是否含中日韩统一表意文字 —— 用来区分「服务端业务中文文案」与「框架英文原文」 */
function hasChinese(s: string): boolean {
  return /[\u4e00-\u9fff]/.test(s)
}
