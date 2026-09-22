import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MotifStore } from '@motif/db'
import { SETTING_DEFS, configHealth } from '@/server/settings'
import { storageFieldVisible } from '@/lib/setting-visibility'

let dir: string
let store: MotifStore
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'motif-ss-'))
  store = new MotifStore(join(dir, 'motif.db'))
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('storage 分组的键', () => {
  it('7 个键都在 storage 组，驱动为枚举且默认 local', () => {
    const keys = SETTING_DEFS.filter((d) => d.group === 'storage').map((d) => d.key)
    expect(keys).toEqual([
      'STORAGE_DRIVER',
      'S3_ENDPOINT',
      'S3_REGION',
      'S3_BUCKET',
      'S3_ACCESS_KEY_ID',
      'S3_SECRET_ACCESS_KEY',
      'S3_FORCE_PATH_STYLE',
    ])
    const driver = SETTING_DEFS.find((d) => d.key === 'STORAGE_DRIVER')!
    expect(driver.kind).toBe('enum')
    expect(driver.options).toEqual(['local', 's3'])
    expect(driver.defaultHint).toBe('local')
  })

  it('密钥类键是 secret（读取只回掩码）', () => {
    expect(SETTING_DEFS.find((d) => d.key === 'S3_SECRET_ACCESS_KEY')!.kind).toBe('secret')
  })

  it('新键既非 readOnly 也非 danger（既有精确集合断言不破）', () => {
    expect(SETTING_DEFS.filter((d) => d.group === 'storage' && (d.readOnly || d.danger))).toEqual([])
  })
})

describe('storage 组显隐', () => {
  it('local 时隐藏全部 S3_*', () => {
    for (const k of [
      'S3_ENDPOINT',
      'S3_REGION',
      'S3_BUCKET',
      'S3_ACCESS_KEY_ID',
      'S3_SECRET_ACCESS_KEY',
      'S3_FORCE_PATH_STYLE',
    ]) {
      expect(storageFieldVisible({ key: k }, 'local')).toBe(false)
    }
  })

  it('s3 时全部可见', () => {
    expect(storageFieldVisible({ key: 'S3_ENDPOINT' }, 's3')).toBe(true)
  })

  it('驱动为 null（未设置）时按 local 处理，隐藏 S3_*', () => {
    expect(storageFieldVisible({ key: 'S3_BUCKET' }, null)).toBe(false)
  })

  it('不误伤其他组的键（对非 storage 组的键一律可见）', () => {
    expect(storageFieldVisible({ key: 'IMAGE_API_KEY' }, 'local')).toBe(true)
    expect(storageFieldVisible({ key: 'LLM_API_KEY' }, 'local')).toBe(true)
    expect(storageFieldVisible({ key: 'STORAGE_DRIVER' }, 'local')).toBe(true)
  })
})

describe('storage 健康探针', () => {
  it('local 恒就绪（本地驱动不需要任何 S3 键）', () => {
    const h = configHealth(store, {}).find((x) => x.group === 'storage')!
    expect(h.ready).toBe(true)
    expect(h.reason).toBeNull()
  })

  it('s3 缺必填时未就绪并给出原因', () => {
    store.setSetting('STORAGE_DRIVER', 's3')
    const h = configHealth(store, {}).find((x) => x.group === 'storage')!
    expect(h.ready).toBe(false)
    expect(h.reason).toMatch(/S3_ENDPOINT|S3_BUCKET/)
  })

  it('s3 三项齐备时就绪', () => {
    store.setSettings([
      { key: 'STORAGE_DRIVER', value: 's3' },
      { key: 'S3_ENDPOINT', value: 'https://s3.example.com' },
      { key: 'S3_BUCKET', value: 'motif-test-bucket' },
      { key: 'S3_ACCESS_KEY_ID', value: 'AKIAEXAMPLE' },
      { key: 'S3_SECRET_ACCESS_KEY', value: 'placeholder-secret' },
    ])
    expect(configHealth(store, {}).find((x) => x.group === 'storage')!.ready).toBe(true)
  })
})
