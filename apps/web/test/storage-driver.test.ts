import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { storagePathFor } from '@motif/db'
import { createStorageFromConfig, describeStorageError, readImageWithFallback, type Storage } from '@/server/storage'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'motif-storage-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const KEY = 'users/u1/topics/t1/references/a.png'

describe('local 驱动与改造前等价', () => {
  const local = () => createStorageFromConfig({ STORAGE_DRIVER: 'local' }, dir)

  it('write 落到 storagePathFor 的同一个路径', async () => {
    await local().write(KEY, Buffer.from('hello'))
    expect(readFileSync(storagePathFor(dir, KEY)).toString()).toBe('hello')
  })

  it('read 读回同一份内容；exists 反映真实存在性', async () => {
    const abs = storagePathFor(dir, KEY)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, 'hello')
    const s = local()
    expect((await s.read(KEY)).toString()).toBe('hello')
    expect(await s.exists(KEY)).toBe(true)
    expect(await s.exists('users/u1/nope.png')).toBe(false)
  })

  it('remove 删掉文件，再 exists 为假；对不存在的 key 不抛错', async () => {
    const s = local()
    await s.write(KEY, Buffer.from('x'))
    await s.remove(KEY)
    expect(await s.exists(KEY)).toBe(false)
    await expect(s.remove(KEY)).resolves.toBeUndefined()
  })

  it('read 缺失时抛错，不返回空 Buffer', async () => {
    await expect(local().read('users/u1/missing.png')).rejects.toThrow()
  })
})

describe('s3 驱动的配置校验', () => {
  it('缺必填项时构造即抛错，错误里点名缺失的键', () => {
    expect(() => createStorageFromConfig({ STORAGE_DRIVER: 's3' }, dir)).toThrow(/S3_ENDPOINT/)
  })

  it('端点会按协议解析出 useSSL 与 port（minio 只收 host/port/useSSL）', () => {
    // 构造成功即说明解析没抛；真实协议由 e2e（有 Docker/MinIO 时）覆盖
    expect(() =>
      createStorageFromConfig(
        {
          STORAGE_DRIVER: 's3',
          S3_ENDPOINT: 'https://s3.example.com',
          S3_BUCKET: 'motif-test-bucket',
          S3_ACCESS_KEY_ID: 'AKIAEXAMPLE',
          S3_SECRET_ACCESS_KEY: 'placeholder-secret',
        },
        dir
      )
    ).not.toThrow()
  })

  it('未知驱动值被拒（不做静默回退）', () => {
    expect(() => createStorageFromConfig({ STORAGE_DRIVER: 'oss' }, dir)).toThrow(/STORAGE_DRIVER/)
  })
})

describe('双读判定（本地优先）', () => {
  const other = (d: string): Storage => createStorageFromConfig({ STORAGE_DRIVER: 'local' }, d)
  let remoteDir: string
  let local: Storage
  let remote: Storage
  beforeEach(() => {
    remoteDir = mkdtempSync(join(tmpdir(), 'motif-storage-remote-'))
    local = other(dir)
    remote = other(remoteDir)
  })
  afterEach(() => rmSync(remoteDir, { recursive: true, force: true }))

  it('本地有：读本地，且**不访问远端**（可证伪的「本地优先」）', async () => {
    await local.write(KEY, Buffer.from('from-local'))
    let remoteTouched = false
    const spy: Storage = {
      read: (k) => remote.read(k),
      write: (k, b) => remote.write(k, b),
      remove: (k) => remote.remove(k),
      exists: (k) => {
        remoteTouched = true
        return remote.exists(k)
      },
    }
    expect((await readImageWithFallback(local, spy, KEY)).toString()).toBe('from-local')
    expect(remoteTouched).toBe(false)
  })

  it('本地无、远端有：读远端', async () => {
    await remote.write(KEY, Buffer.from('from-remote'))
    expect((await readImageWithFallback(local, remote, KEY)).toString()).toBe('from-remote')
  })

  it('两边都无：抛错（不返回空 Buffer）', async () => {
    await expect(readImageWithFallback(local, remote, KEY)).rejects.toThrow(/不存在/)
  })

  it('local 驱动下 remote 传 null 时只读本地', async () => {
    await local.write(KEY, Buffer.from('only-local'))
    expect((await readImageWithFallback(local, null, KEY)).toString()).toBe('only-local')
    await expect(readImageWithFallback(local, null, 'nope.png')).rejects.toThrow()
  })
})

describe('异常渲染成能看的话', () => {
  it('普通 Error 原样返回 message（不加 code）', () => {
    expect(describeStorageError(new Error('STORAGE_DRIVER=s3 缺少配置：S3_BUCKET'))).toBe(
      'STORAGE_DRIVER=s3 缺少配置：S3_BUCKET'
    )
  })

  it('message 非空且带 code 时两者都给出（便于定位鉴权 / 桶名问题）', () => {
    const e = Object.assign(new Error('Access Denied.'), { code: 'AccessDenied' })
    expect(describeStorageError(e)).toBe('Access Denied.（AccessDenied）')
  })

  it('⚠️ minio 的 S3Error 在服务端没回 <Message> 时 message 是空串 —— 必须回退到 code，不能输出空串', () => {
    // 实测构造：S3Error 的 message === ''、String(e) === 'S3Error'
    const e = Object.assign(new Error(''), { name: 'S3Error', code: 'NoSuchKey' })
    expect(describeStorageError(e)).toBe('S3Error: NoSuchKey')
  })

  it('连 code 都没有时回退到 name（仍然不是空串）', () => {
    const e = Object.assign(new Error(''), { name: 'S3Error' })
    expect(describeStorageError(e)).toBe('S3Error')
  })

  it('非 Error 值也能渲染', () => {
    expect(describeStorageError('boom')).toBe('boom')
    expect(describeStorageError(undefined)).toBe('undefined')
  })
})

describe('依赖边界', () => {
  it('packages/db 不依赖任何 S3 SDK（db 是 SQLite 层，不该拖进对象存储）', async () => {
    const { readFileSync: read } = await import('node:fs')
    const pkg = JSON.parse(read(new URL('../../../packages/db/package.json', import.meta.url), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    const deps = Object.keys(pkg.dependencies ?? {})
    expect(deps.filter((d) => /minio|aws-sdk/.test(d))).toEqual([])
  })
})
