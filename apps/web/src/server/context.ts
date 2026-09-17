import path from 'node:path'
import { MotifStore } from '@motif/db'
import { createImageProviderFromEnv, type ImageProvider } from '@motif/image-provider'
import { createMailerFromEnv, type MailerConfig } from './mailer'

/**
 * 运行时上下文单例：SQLite 存储、生图 Provider、邮件发送。
 * Next.js dev 模式模块会被重复加载，挂到 globalThis 上保证唯一。
 */
interface MotifRuntime {
  store: MotifStore
  provider: ImageProvider
  mailer: MailerConfig
  dataDir: string
}

const g = globalThis as unknown as { __motifRuntime?: MotifRuntime }

export function getRuntime(): MotifRuntime {
  if (!g.__motifRuntime) {
    const dataDir = process.env.MOTIF_DATA_DIR || path.join(process.cwd(), '.data')
    const dbFile = process.env.MOTIF_DB_FILE || path.join(dataDir, 'motif.db')
    const store = new MotifStore(dbFile)
    const provider = createImageProviderFromEnv()
    const mailer = createMailerFromEnv()
    g.__motifRuntime = { store, provider, mailer, dataDir }
  }
  return g.__motifRuntime
}
