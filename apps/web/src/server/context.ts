import path from 'node:path'
import { MotifStore } from '@motif/db'
import { createImageProviderFromEnv, type ImageProvider } from '@motif/image-provider'
import { MisconfiguredMailer, createMailerFromConfig, type MailerConfig } from './mailer'
import { resolveConfigValues } from './settings'

/**
 * 运行时上下文单例：SQLite 存储、生图 Provider、邮件发送。
 * Next.js dev 模式模块会被重复加载，挂到 globalThis 上保证唯一。
 *
 * provider 与 mailer 都从**配置**构造，而配置的真相在 settings 表（数据库优先、回退环境变量）。
 */
interface MotifRuntime {
  store: MotifStore
  provider: ImageProvider
  mailer: MailerConfig
  dataDir: string
}

const g = globalThis as unknown as { __motifRuntime?: MotifRuntime }

/**
 * 配置不全时的占位 provider：**构造不抛错，抛错推迟到真正发起生成时**。
 *
 * 为什么必须这样：全新部署的 .env 是空的，而「在设置页填生图密钥」正是要支持的路径 ——
 * 若构造就抛错，getRuntime() 会失败，所有接口 500，设置页永远打不开，用户就永远无法完成配置。
 * 抛错落在 generate() 上时，失败会走既有的「消息置 failed + 按已生成数退额」路径，额度不会凭空消失。
 */
class UnconfiguredProvider implements ImageProvider {
  readonly name = 'unconfigured'

  constructor(private readonly reason: string) {}

  async generate(): Promise<never> {
    throw new Error(this.reason)
  }
}

function buildProvider(store: MotifStore): ImageProvider {
  const values = resolveConfigValues(store, process.env)
  try {
    return createImageProviderFromEnv(values)
  } catch (e) {
    return new UnconfiguredProvider(e instanceof Error ? e.message : String(e))
  }
}

function buildMailer(store: MotifStore): MailerConfig {
  const values = resolveConfigValues(store, process.env)
  try {
    return createMailerFromConfig(values)
  } catch (e) {
    // isConsole: false —— 配置坏了更不能把验证码直出回传给调用方
    return { mailer: new MisconfiguredMailer(e instanceof Error ? e.message : String(e)), isConsole: false }
  }
}

export function getRuntime(): MotifRuntime {
  if (!g.__motifRuntime) {
    const dataDir = process.env.MOTIF_DATA_DIR || path.join(process.cwd(), '.data')
    const dbFile = process.env.MOTIF_DB_FILE || path.join(dataDir, 'motif.db')
    const store = new MotifStore(dbFile)
    g.__motifRuntime = { store, provider: buildProvider(store), mailer: buildMailer(store), dataDir }
  }
  return g.__motifRuntime
}

/**
 * 配置变更后重建 provider 与 mailer，无需重启进程。
 *
 * ⚠️ **原地改字段，不整体替换对象**。理由有两条：
 * 1. store 与 dataDir 必须原样保留。worker 在启动时持有 store 实例；换成新连接会让它
 *    在旧连接上继续写（甚至写一个已被 close 的库），而 SQLite 同文件双连接还会各自
 *    看到不同的 WAL 视图。
 * 2. 整体替换会把「保住 store 与 dataDir」变成一句必须记得的约定。原地改字段后，
 *    这两个字段物理上不可能被顺手丢掉 —— 也顺带让「注入的 partial fake runtime」
 *    （测试里常见的 `{ store } as never`）在失效后仍是原来的形状，而不是丢掉 dataDir。
 *
 * 幂等：连续调用任意多次，store 与 dataDir 始终不变。
 */
export function invalidateRuntime(): void {
  const cur = g.__motifRuntime
  if (!cur) return
  cur.provider = buildProvider(cur.store)
  cur.mailer = buildMailer(cur.store)
}
