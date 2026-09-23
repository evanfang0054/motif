import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { storagePathFor } from '@motif/db'
import { createStorageFromConfig, type Storage } from '@/server/storage'
import { listLocalKeys, planMigration, runMigration } from '@/server/storage-migrate'

/**
 * 用「另一个本地目录」当远端：同一套 Storage 接口，不依赖网络 / Docker。
 * 它证明的是**逻辑**（幂等、跳过、dry-run 不动数据）；真实 S3 协议由 Task 8 的 ego 步骤覆盖。
 */
let dir: string
let remoteDir: string
let remote: Storage

const remoteAt = (d: string): Storage => createStorageFromConfig({ STORAGE_DRIVER: 'local' }, d)

function seedLocal(keys: string[]) {
  for (const k of keys) {
    const abs = storagePathFor(dir, k)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, `content-of-${k}`)
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'motif-mig-src-'))
  remoteDir = mkdtempSync(join(tmpdir(), 'motif-mig-dst-'))
  remote = remoteAt(remoteDir)
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(remoteDir, { recursive: true, force: true })
})

const A = 'users/u1/topics/t1/references/a.png'
const B = 'users/u1/topics/t1/messages/m1/generated/b.png'

describe('本地 key 枚举', () => {
  it('递归枚举并按相对路径给出 key（与 imageKey 同构），输出**排序**以保证确定性', () => {
    seedLocal([A, B])
    // 字典序：messages/ 在 references/ 之前，故 B 排在 A 前面
    expect(listLocalKeys(dir)).toEqual([B, A])
  })

  it('storage 目录不存在时返回空数组（不是抛错）', () => {
    expect(listLocalKeys(dir)).toEqual([])
  })
})

describe('搬迁幂等性', () => {
  it('首次搬迁把本地对象集合搬到远端', async () => {
    seedLocal([A, B])
    expect(await runMigration(dir, remote)).toEqual({ uploaded: 2, skipped: 0, orphaned: 0 })
    expect(await remote.exists(A)).toBe(true)
    expect(await remote.exists(B)).toBe(true)
  })

  it('重复执行不重复上传（第二次 uploaded 为 0）', async () => {
    seedLocal([A, B])
    await runMigration(dir, remote)
    expect(await runMigration(dir, remote)).toEqual({ uploaded: 0, skipped: 2, orphaned: 0 })
  })

  it('部分已存在时只补缺的（断点续跑），且已存在的**不被覆盖**', async () => {
    seedLocal([A, B])
    await remote.write(A, Buffer.from('already-there'))
    const plan = await planMigration(dir, remote)
    expect(plan.pending).toEqual([B])
    expect(plan.skipped).toEqual([A])
    await runMigration(dir, remote)
    expect((await remote.read(A)).toString()).toBe('already-there')
  })

  it('planMigration 不改变任何一侧的对象集合（dry-run 语义）', async () => {
    seedLocal([A, B])
    await planMigration(dir, remote)
    expect(await remote.exists(A)).toBe(false)
    expect(await remote.exists(B)).toBe(false)
    expect(listLocalKeys(dir)).toEqual([B, A])
  })

  it('不变量：跑完即收敛（远端对象集合等于本地）', async () => {
    seedLocal([A, B])
    await runMigration(dir, remote)
    const remoteKeys: string[] = []
    for (const k of listLocalKeys(dir)) if (await remote.exists(k)) remoteKeys.push(k)
    expect(remoteKeys).toEqual(listLocalKeys(dir))
  })
})
