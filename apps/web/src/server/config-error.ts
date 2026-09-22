/**
 * 配置缺失 / 写坏导致的失败，与业务错误、代码缺陷区分开。
 *
 * 为什么单独一类：这类失败**运营自己能修**（去管理后台补配置），若和真实 500 一样回落成
 * 「服务器开小差了」，运营只能翻服务器日志才能定位。`jsonError` 据此把它转成带指引的 503。
 *
 * `detail`（缺哪些键、哪个渠道选错）只进服务端日志；对外的 message 是固定指引，
 * 不含内部键名 —— 与 `startCheckout` 的 503 口径一致。
 *
 * 独立成文件是为了避免循环依赖：`context.ts` 与 `mailer.ts` 都要用它，
 * 而 `context.ts` 已被 `services.ts` / `http.ts` 依赖。
 */
export class ConfigError extends Error {
  /** 面向用户的固定指引（不透内部键名） */
  static readonly USER_MESSAGE = '服务配置不完整，请到管理后台「系统设置」补全配置后重试。'

  readonly detail: string

  constructor(detail: string) {
    super(detail)
    this.name = 'ConfigError'
    this.detail = detail
  }
}
