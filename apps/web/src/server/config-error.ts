/**
 * 配置缺失 / 写坏导致的失败，与业务错误、代码缺陷区分开。
 *
 * 为什么单独一类：这类失败**运营自己能修**（去管理后台补配置），若和真实 500 一样回落成
 * 「服务器开小差了」，运营只能翻服务器日志才能定位。`jsonError` 据此把它转成带指引的 503。
 *
 * `detail`（缺哪些键、哪个渠道选错）只进服务端日志；对外的 message 是固定指引，
 * 不含内部键名 —— 与 `startCheckout` 的 503 口径一致。
 *
 * 独立成文件是为了避免循环依赖：`context.ts` 与 `mailer.ts` 都要用它，而 `mailer.ts` 已被
 * `context.ts` 依赖（放进 `context.ts` 就会成环 `mailer → context → mailer`）。
 */
export class ConfigError extends Error {
  /**
   * 面向**调用方**的固定文案，不透内部键名。
   *
   * ⚠️ 刻意**不**写「请到管理后台补配置」：这句会经 `jsonError` 的 503 回到**普通用户**
   * （可达路径：注册发验证码时邮件渠道没配好）。管理端有自己的系统设置页，不靠这句指路。
   */
  static readonly USER_MESSAGE = '服务暂时不可用'

  readonly detail: string

  constructor(detail: string) {
    super(detail)
    this.name = 'ConfigError'
    this.detail = detail
  }
}
