import path from 'node:path'
import { MotifStore } from '@motif/db'
import { createImageProviderFromEnv, type ImageProvider } from '@motif/image-provider'
import { MisconfiguredMailer, createMailerFromConfig, type MailerConfig } from './mailer'
import { ConfigError } from './config-error'
import { createStorageFromConfig, type Storage } from './storage'
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
 * 抛 `ConfigError` 是为了让**不经生成链路**的调用点（若将来有）也能被 `jsonError` 识别成配置问题。
 */
class UnconfiguredProvider implements ImageProvider {
  readonly name = 'unconfigured'

  constructor(private readonly reason: string) {}

  async generate(): Promise<never> {
    throw new ConfigError(this.reason)
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

/**
 * 按当前配置取图片存储实现。
 *
 * 为什么放 context 而不是 storage.ts：`storage.ts` 要被 `settings.ts` 引用（健康探针复用其
 * 构造器），若它反过来 import settings 就成环 —— context 同时依赖两者，是天然汇合点。
 *
 * ⚠️ **不缓存**（每次重新构造）：与 worker 不缓存 provider 同理，配置可在管理后台热改，
 * 缓存它会让「改了驱动、页面显示成功、实际仍写旧位置」静默失效。s3 客户端构造是纯对象组装
 * （无网络），开销可忽略。
 */
export function resolveStorage(dataDir?: string): Storage {
  const rt = getRuntime()
  // ⚠️ 必须尊重调用方显式传入的 dataDir：services 层把它当参数一路透传（测试与 CLI 用临时目录），
  // 若这里一律取 runtime 的，文件会被写到 cwd/.data 而不是调用方指定的目录。
  return createStorageFromConfig(resolveConfigValues(rt.store, process.env), dataDir ?? rt.dataDir)
}

/**
 * 双读里的「远端」：**只在当前驱动为 s3 时才存在**。
 * local 驱动下返回 null，让 readImageWithFallback 跳过远端探测（不做无意义的构造与网络调用）。
 */
export function resolveRemoteStorage(dataDir?: string): Storage | null {
  const rt = getRuntime()
  const values = resolveConfigValues(rt.store, process.env)
  if ((values.STORAGE_DRIVER || 'local').toLowerCase() !== 's3') return null
  return createStorageFromConfig(values, dataDir ?? rt.dataDir)
}

/**
 * 双读里的「本地」：**永远指向本地目录**，与当前驱动无关。
 *
 * ⚠️ 不能拿 `resolveStorage()` 当本地用 —— s3 驱动下它返回的是**远端**，于是双读的两个入参
 * 变成同一个远端，「本地优先」直接失效：切到 s3 且还没搬迁时，本地老图会 404（实测复现过）。
 * 「本地」的语义是「这个进程所在机器上的 dataDir」，不是「当前驱动的目标」。
 */
export function resolveLocalStorage(dataDir?: string): Storage {
  const rt = getRuntime()
  return createStorageFromConfig({ STORAGE_DRIVER: 'local' }, dataDir ?? rt.dataDir)
}

/**
 * 一次拿到双读的两侧，**避免调用方各自拼错**（这正是「s3 驱动下把远端当本地」的成因）。
 * 读图片一律走这个，不要自己拿 `resolveStorage()` 凑。
 */
export function resolveReadStorages(dataDir?: string): { local: Storage; remote: Storage | null } {
  return { local: resolveLocalStorage(dataDir), remote: resolveRemoteStorage(dataDir) }
}

/**
 * 删除时把**两侧**都清掉（#58）。
 *
 * 为什么不能只删当前驱动那一份：双读存在时同一个 key 可能在本地与远端各有一份 ——
 * s3 驱动下只删远端 → 本地残留；local 驱动下只删本地 → 远端残留。而残留的那一份会让
 * `planMigration` 认为「远端不存在」从而把它**重新上传**（DB 行已删，桶里却持续堆积垃圾）。
 *
 * 对象身份来自刚删除的 DB 行，key 是确定的，所以不存在「跨驱动误删」的风险。
 * best-effort：单个失败不吞掉整个请求（行已删，文件残留不影响功能，孤儿由搬迁统计兜底）。
 * 复用 `resolveRemoteStorage()` 的语义 —— 它**只在 s3 驱动下非 null**，所以 local 驱动时只删一次。
 */
export async function removeFromAllStorages(key: string, dataDir?: string): Promise<void> {
  // ⚠️ 构造也要包起来：选了 s3 但凭据没填全时 `resolveRemoteStorage()` **直接抛**，
  // 那样连本地那份都清不掉、请求还会报错。构造失败一律视为「没有远端」，继续清本地。
  let remote: Storage | null = null
  try {
    remote = resolveRemoteStorage(dataDir)
  } catch {
    remote = null
  }
  const targets = remote ? [remote, resolveLocalStorage(dataDir)] : [resolveLocalStorage(dataDir)]
  for (const storage of targets) {
    try {
      await storage.remove(key)
    } catch {
      // 对象可能已被清理，或远端暂时不可达 —— 忽略
    }
  }
}
