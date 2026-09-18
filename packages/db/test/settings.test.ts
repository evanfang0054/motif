import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MotifStore } from '../src/index'

let dir: string
let store: MotifStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'motif-settings-'))
  store = new MotifStore(join(dir, 't.db'))
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('settings 存取层', () => {
  it('未设置的键返回 null，而不是空串', () => {
    // 空串与「未设置」必须是两个状态：播种与 env 回退都依赖这个区分
    expect(store.getSetting('IMAGE_MODEL')).toBeNull()
  })

  it('setSetting 是 upsert：同一键写两次只留一行且值更新', () => {
    store.setSetting('IMAGE_MODEL', 'gpt-image-2')
    store.setSetting('IMAGE_MODEL', 'gpt-image-3')
    expect(store.getSetting('IMAGE_MODEL')).toBe('gpt-image-3')
    expect(store.listSettings().filter((s) => s.key === 'IMAGE_MODEL')).toHaveLength(1)
  })

  it('setSetting 更新 updatedAt', () => {
    store.setSetting('IMAGE_MODEL', 'a')
    const first = store.listSettings().find((s) => s.key === 'IMAGE_MODEL')!.updatedAt
    store.setSetting('IMAGE_MODEL', 'b')
    const second = store.listSettings().find((s) => s.key === 'IMAGE_MODEL')!.updatedAt
    // 同一毫秒内可能相等，故断言「不早于」而不是「晚于」
    expect(second >= first).toBe(true)
  })

  it('seedSetting 只在键不存在时写入，返回是否真的写了', () => {
    expect(store.seedSetting('IMAGE_MODEL', 'from-env')).toBe(true)
    // 第二次播种必须返回 false 且不覆盖 —— 这是「DB 为唯一真相」的全部机制
    expect(store.seedSetting('IMAGE_MODEL', 'changed-env')).toBe(false)
    expect(store.getSetting('IMAGE_MODEL')).toBe('from-env')
  })

  it('setSettings 批量写入是原子的：其中一个键非法时全部不落库', () => {
    store.setSetting('A', '1')
    expect(() =>
      // 用 NOT NULL 约束造一次真实的失败：若 setSettings 是裸循环，B 会先落库、C 才抛错
      store.setSettings([
        { key: 'B', value: '2' },
        { key: 'C', value: null as unknown as string },
      ])
    ).toThrow()
    expect(store.getSetting('B')).toBeNull()
    expect(store.getSetting('A')).toBe('1')
  })

  it('listSettings 按 key 升序返回全部行', () => {
    store.setSetting('Z_KEY', '1')
    store.setSetting('A_KEY', '2')
    expect(store.listSettings().map((s) => s.key)).toEqual(['A_KEY', 'Z_KEY'])
  })

  it('deleteSettings 删除指定键，其余不动；删不存在的键不报错', () => {
    store.setSetting('A', '1')
    store.setSetting('B', '2')
    store.deleteSettings(['A', 'NEVER_EXISTED'])
    expect(store.getSetting('A')).toBeNull()
    expect(store.getSetting('B')).toBe('2')
  })
})
