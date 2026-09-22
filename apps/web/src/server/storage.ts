import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Client as MinioClient } from 'minio'
import { storagePathFor } from '@motif/db'

/**
 * 图片二进制存储的统一入口：**只有这里知道「图片存在哪」**。
 *
 * 为什么不放进 `packages/db`：db 包是 SQLite 存储层，不该依赖 S3 SDK；`storagePathFor`
 * 这类纯路径函数留在 db 包不动（它同时被 db 的既有调用点使用）。
 *
 * ⚠️ 本文件**刻意不 import `./settings`** —— `settings.ts` 要 import 本文件的
 * `createStorageFromConfig` 做健康探针，反向 import 会成环。按配置取实现的那个函数
 * （`resolveStorage`）放在 `context.ts`（它同时依赖 settings 与 store，是天然汇合点）。
 *
 * 双读（D8）：本地有就读本地、本地没有才读远端 —— 让「切到 s3」不必等搬迁跑完，
 * 也让搬迁中断期间服务照常可用。
 */
export interface Storage {
  read(key: string): Promise<Buffer>
  write(key: string, buffer: Buffer): Promise<void>
  remove(key: string): Promise<void>
  exists(key: string): Promise<boolean>
}

function localStorage(dataDir: string): Storage {
  const abs = (key: string) => storagePathFor(dataDir, key)
  return {
    async read(key) {
      // 刻意让 readFileSync 的错误冒泡：调用方需要区分「文件缺失」与「读到空内容」
      return readFileSync(abs(key))
    },
    async write(key, buffer) {
      const p = abs(key)
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, buffer)
    },
    async remove(key) {
      try {
        unlinkSync(abs(key))
      } catch {
        // 已不存在即达成目标
      }
    },
    async exists(key) {
      return existsSync(abs(key))
    },
  }
}

/** minio 的 ClientOptions 只收 host/port/useSSL，而我们配的是 URL —— 这里做一次显式解析 */
function parseEndpoint(raw: string): { endPoint: string; port: number; useSSL: boolean } {
  const url = new URL(raw)
  const useSSL = url.protocol === 'https:'
  return {
    endPoint: url.hostname,
    port: url.port ? Number(url.port) : useSSL ? 443 : 80,
    useSSL,
  }
}

/** minio 的 getObject 返回 Readable 流，而 Storage.read 约定返回 Buffer */
function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    stream.on('data', (c: Buffer) => chunks.push(c))
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', reject)
  })
}

function s3Storage(values: Record<string, string | undefined>): Storage {
  const required = ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const
  const missing = required.filter((k) => !values[k])
  if (missing.length) throw new Error(`[motif] STORAGE_DRIVER=s3 缺少配置：${missing.join(', ')}`)

  const { endPoint, port, useSSL } = parseEndpoint(values.S3_ENDPOINT!)
  const bucket = values.S3_BUCKET!
  const client = new MinioClient({
    endPoint,
    port,
    useSSL,
    accessKey: values.S3_ACCESS_KEY_ID!,
    secretKey: values.S3_SECRET_ACCESS_KEY!,
    // MinIO 等自建服务需要 path-style 寻址（虚拟主机式要求 DNS 泛解析）
    pathStyle: values.S3_FORCE_PATH_STYLE ? values.S3_FORCE_PATH_STYLE !== 'false' : false,
    ...(values.S3_REGION ? { region: values.S3_REGION } : {}),
  })

  return {
    async read(key) {
      return streamToBuffer(await client.getObject(bucket, key))
    },
    async write(key, buffer) {
      await client.putObject(bucket, key, buffer, buffer.length)
    },
    async remove(key) {
      await client.removeObject(bucket, key)
    },
    async exists(key) {
      try {
        await client.statObject(bucket, key)
        return true
      } catch (e) {
        // ⚠️ 只把「确实不存在」当 false，其余（连接失败 / 鉴权失败）必须冒泡：
        // 全吞成 false 会把「远端不可达」伪装成「远端没有」—— dry-run 会虚报待搬数量，
        // 双读也会把网络故障误报成「文件不存在」，把真正的原因藏起来。
        //
        // 关于 code 的实测口径（minio@8.0.7）：statObject 走 HEAD，404 响应**没有 body**，
        // 于是 parseResponseError 按状态码给出 `NotFound`。因此**桶名配错（NoSuchBucket）也会
        // 落到这里被当成 false** —— 这是 HEAD 语义下的固有取舍，不是漏判。
        // 真要把「桶配错」区分出来，唯一可靠的位置是**写路径**（putObject 会带回 NoSuchBucket），
        // 而写路径本就按驱动走、不经过本函数。故此处保持「404 即不存在」。
        const code = (e as { code?: string }).code
        if (code === 'NotFound' || code === 'NoSuchKey') return false
        throw e
      }
    },
  }
}

/**
 * 从取值表构造存储实现。
 * 驱动值未知、或 s3 缺必填时**直接抛错** —— `configHealth` 复用同一份判据，不手写第二份清单。
 */
export function createStorageFromConfig(values: Record<string, string | undefined>, dataDir: string): Storage {
  const driver = (values.STORAGE_DRIVER || 'local').toLowerCase()
  if (driver === 'local') return localStorage(dataDir)
  if (driver === 's3') return s3Storage(values)
  throw new Error(`[motif] STORAGE_DRIVER 只能是 local 或 s3，当前为「${values.STORAGE_DRIVER}」`)
}

/**
 * 把存储层抛出的异常渲染成一句能看的话。
 *
 * ⚠️ minio 的 `S3Error` 在服务端响应里没有 `<Message>` 时，**`message` 是空串**
 * （`String(e)` 也只剩 `"S3Error"`）。直接插值会打出「搬迁失败：」这种什么都没说的日志，
 * 运维根本无从下手。故按 message → code → name 依次兜底，并把 code 一并带上。
 */
export function describeStorageError(e: unknown): string {
  if (!(e instanceof Error)) return String(e)
  const code = (e as { code?: string }).code
  if (e.message) return code ? `${e.message}（${code}）` : e.message
  return code ? `${e.name}: ${code}` : e.name
}

/**
 * 双读：本地优先，本地没有才问远端。
 *
 * 抽成独立函数（而不是塞进某个驱动里）是因为它是**跨驱动**的策略：local 驱动下问远端毫无
 * 意义，故调用方在 local 驱动下传 `remote = null`，本函数便只读本地。
 * 两边都没有时抛错 —— 调用方据此区分「文件缺失」（→ 404）与「读到空内容」。
 */
export async function readImageWithFallback(local: Storage, remote: Storage | null, key: string): Promise<Buffer> {
  if (await local.exists(key)) return local.read(key)
  if (remote && (await remote.exists(key))) return remote.read(key)
  throw new Error(`[motif] 图片文件不存在：${key}`)
}
