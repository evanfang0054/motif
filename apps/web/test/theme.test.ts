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

describe('首帧防闪内联脚本', () => {
  it('读的是同一个 localStorage 键与同一条媒体查询（改一处必须两处一起动）', () => {
    expect(THEME_INIT_SCRIPT).toContain(THEME_STORAGE_KEY)
    expect(THEME_INIT_SCRIPT).toContain(DARK_MEDIA_QUERY)
    expect(THEME_INIT_SCRIPT).toContain(DEFAULT_THEME_MODE)
  })

  it('整段包在 try/catch 里（隐私模式下 localStorage 抛错不能让首帧闪浅色）', () => {
    expect(THEME_INIT_SCRIPT.startsWith('(function(){try{')).toBe(true)
    expect(THEME_INIT_SCRIPT).toContain('catch(e){}')
  })

  it('只在深色时写 data-theme，浅色时删除属性（亮色是「无属性」的基线态）', () => {
    expect(THEME_INIT_SCRIPT).toContain("document.documentElement.dataset.theme='dark'")
    expect(THEME_INIT_SCRIPT).toContain('delete document.documentElement.dataset.theme')
  })
})
