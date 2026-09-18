import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootstrapConfig } from '@/instrumentation'
import { getRuntime } from '@/server/context'

let dir: string
const saved: Record<string, string | undefined> = {}
const TOUCHED = ['MOTIF_DATA_DIR', 'MOTIF_DB_FILE', 'IMAGE_API_BASE_URL', 'IMAGE_API_KEY', 'IMAGE_MODEL']

function clearRuntime(): void {
  delete (globalThis as unknown as { __motifRuntime?: unknown }).__motifRuntime
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'motif-settings-boot-'))
  for (const k of TOUCHED) saved[k] = process.env[k]
  process.env.MOTIF_DATA_DIR = dir
  process.env.MOTIF_DB_FILE = join(dir, 't.db')
  process.env.IMAGE_API_BASE_URL = 'https://gw.example/v1'
  process.env.IMAGE_API_KEY = 'sk-boot'
  process.env.IMAGE_MODEL = 'boot-model'
  clearRuntime()
})

afterEach(() => {
  getRuntime().store.close()
  clearRuntime()
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(dir, { recursive: true, force: true })
})

describe('启动播种步骤（契约要求的「空库首次启动后」）', () => {
  it('空库首次启动后，settings 表含由环境变量播种的键', async () => {
    const seeded = await bootstrapConfig()
    expect(seeded).toContain('IMAGE_API_BASE_URL')
    expect(seeded).toContain('IMAGE_API_KEY')
    expect(getRuntime().store.getSetting('IMAGE_API_BASE_URL')).toBe('https://gw.example/v1')
  })

  it('播种后运行时立即按库里的值构造（不需要重启进程）', async () => {
    await bootstrapConfig()
    expect(getRuntime().provider.name).toBe('boot-model')
  })

  it('环境变量变化后再次启动，已播种的键取值仍为库中的值', async () => {
    await bootstrapConfig()
    process.env.IMAGE_MODEL = 'changed-after-boot'
    const seededAgain = await bootstrapConfig()
    expect(seededAgain).not.toContain('IMAGE_MODEL')
    expect(getRuntime().store.getSetting('IMAGE_MODEL')).toBe('boot-model')
    expect(getRuntime().provider.name).toBe('boot-model')
  })

  it('环境变量里没有的键不会被播种（不写空值）', async () => {
    delete process.env.IMAGE_MODEL
    const seeded = await bootstrapConfig()
    expect(seeded).not.toContain('IMAGE_MODEL')
    expect(getRuntime().store.getSetting('IMAGE_MODEL')).toBeNull()
  })

  it('只读键（数据位置）永不入库', async () => {
    await bootstrapConfig()
    expect(getRuntime().store.getSetting('MOTIF_DATA_DIR')).toBeNull()
    expect(getRuntime().store.getSetting('MOTIF_DB_FILE')).toBeNull()
  })
})
