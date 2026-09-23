import { describe, expect, it } from 'vitest'
import {
  DARK_MEDIA_QUERY,
  DEFAULT_THEME_MODE,
  THEME_INIT_SCRIPT,
  THEME_STORAGE_KEY,
  isDarkTheme,
  parseThemeMode,
} from '@/lib/theme'

describe('主题三态解析（#73-1.1）', () => {
  it('合法三态原样返回', () => {
    expect(parseThemeMode('light')).toBe('light')
    expect(parseThemeMode('dark')).toBe('dark')
    expect(parseThemeMode('system')).toBe('system')
  })

  it('缺失 / 空串 / 脏值一律回退默认（脏 localStorage 不能把主题打坏）', () => {
    expect(parseThemeMode(null)).toBe(DEFAULT_THEME_MODE)
    expect(parseThemeMode(undefined)).toBe(DEFAULT_THEME_MODE)
    expect(parseThemeMode('')).toBe(DEFAULT_THEME_MODE)
    expect(parseThemeMode('Dark')).toBe(DEFAULT_THEME_MODE)
    expect(parseThemeMode('auto')).toBe(DEFAULT_THEME_MODE)
    expect(parseThemeMode('{"theme":"dark"}')).toBe(DEFAULT_THEME_MODE)
  })

  it('默认是浅色，不是跟随系统', () => {
    expect(DEFAULT_THEME_MODE).toBe('light')
  })
})

describe('深色判定', () => {
  it('dark / light 只看模式本身 —— 系统切换不该改用户明确选过的档', () => {
    expect(isDarkTheme('dark', false)).toBe(true)
    expect(isDarkTheme('dark', true)).toBe(true)
    expect(isDarkTheme('light', true)).toBe(false)
    expect(isDarkTheme('light', false)).toBe(false)
  })

  it('system 才跟随系统偏好', () => {
    expect(isDarkTheme('system', true)).toBe(true)
    expect(isDarkTheme('system', false)).toBe(false)
  })
})

/**
 * 首帧防闪内联脚本的**真值表**测试。
 *
 * 为什么不能只断言字符串包含：那种写法把「实现里有这段字」当成「行为对」，
 * 极性写反（`if (!d)`）、把 `delete` 换成 `setAttribute('data-theme','light')`
 * 都能照样通过。这里在 node 环境（无 jsdom）临时把 `document` / `localStorage` /
 * `window` 挂到 `globalThis` 上，直接执行 `THEME_INIT_SCRIPT`，只断言它**做了什么**。
 * 用完即还原，不污染其他用例（`apps/web` 的 vitest 是 `environment: 'node'`）。
 */
interface RunResult {
  /** 脚本执行后 `documentElement.dataset.theme` 的值（未写 / 被删 → null） */
  theme: string | null
  /** 脚本读过的 localStorage 键（用来钉「三处共用同一个键」） */
  readKeys: string[]
  /** 脚本查询过的媒体查询串（用来钉「监听与判定共用同一条查询」） */
  queriedMedia: string[]
}

function runThemeInit(
  opts: { stored?: string | null; systemDark?: boolean; storageThrows?: boolean } = {}
): RunResult {
  const { stored = null, systemDark = false, storageThrows = false } = opts
  const dataset: Record<string, string | undefined> = {}
  const readKeys: string[] = []
  const queriedMedia: string[] = []

  const stubDocument = { documentElement: { dataset } }
  const stubLocalStorage = {
    getItem(key: string) {
      readKeys.push(key)
      if (storageThrows) throw new Error('storage disabled')
      return key === THEME_STORAGE_KEY ? stored : null
    },
  }
  const stubWindow = {
    matchMedia(query: string) {
      queriedMedia.push(query)
      return { matches: systemDark, media: query }
    },
  }

  const g = globalThis as unknown as Record<string, unknown>
  const prev = { document: g.document, localStorage: g.localStorage, window: g.window }
  g.document = stubDocument
  g.localStorage = stubLocalStorage
  g.window = stubWindow
  try {
    new Function(THEME_INIT_SCRIPT)()
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) Reflect.deleteProperty(g, key)
      else g[key] = value
    }
  }
  return { theme: dataset.theme ?? null, readKeys, queriedMedia }
}

describe('首帧防闪内联脚本（真值表：3 档 × 系统亮/暗 = 6 种组合）', () => {
  it('dark 恒落暗色 —— 系统偏好不改用户已选档', () => {
    expect(runThemeInit({ stored: 'dark', systemDark: false }).theme).toBe('dark')
    expect(runThemeInit({ stored: 'dark', systemDark: true }).theme).toBe('dark')
  })

  it('light 恒删属性（亮色是「无属性」的基线态）', () => {
    expect(runThemeInit({ stored: 'light', systemDark: false }).theme).toBe(null)
    expect(runThemeInit({ stored: 'light', systemDark: true }).theme).toBe(null)
  })

  it('system 才跟随 matchMedia.matches', () => {
    expect(runThemeInit({ stored: 'system', systemDark: true }).theme).toBe('dark')
    expect(runThemeInit({ stored: 'system', systemDark: false }).theme).toBe(null)
  })

  it('缺失存储值走默认档（默认是浅色 ⇒ 即便系统暗也不写属性）', () => {
    // 若 DEFAULT_THEME_MODE 被改成 'dark' / 'system'，这条会红 —— 钉住「默认不跟随系统」。
    expect(runThemeInit({ stored: null, systemDark: true }).theme).toBe(null)
  })

  it('读的键与媒体查询和常量一致（改一处必须两处一起动）', () => {
    const res = runThemeInit({ stored: 'system', systemDark: true })
    expect(res.readKeys).toEqual([THEME_STORAGE_KEY])
    expect(res.queriedMedia).toEqual([DARK_MEDIA_QUERY])
  })

  it('localStorage 抛错（隐私模式）不崩、不写属性（整段包在 try/catch 里）', () => {
    const res = runThemeInit({ stored: 'dark', systemDark: true, storageThrows: true })
    expect(res.theme).toBe(null)
  })
})
