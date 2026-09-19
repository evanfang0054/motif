import { describe, expect, it } from 'vitest'
import { formatDateTime } from '@/lib/format'

const ISO = '2026-09-19T01:30:06.462Z' // UTC

describe('formatDateTime（UTC ISO → 本地时区展示）', () => {
  it('指定时区：UTC 视角还原为 UTC 墙上时间', () => {
    expect(formatDateTime(ISO, { timeZone: 'UTC' })).toBe('2026-09-19 01:30:06')
  })

  it('指定时区：北京时间 +8', () => {
    expect(formatDateTime(ISO, { timeZone: 'Asia/Shanghai' })).toBe('2026-09-19 09:30:06')
  })

  it('无时区参数：按运行环境本地时区渲染（格式固定 YYYY-MM-DD HH:mm:ss）', () => {
    expect(formatDateTime(ISO)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })

  it('空值返回占位符；非法串原样返回', () => {
    expect(formatDateTime(null)).toBe('—')
    expect(formatDateTime('')).toBe('—')
    expect(formatDateTime('not-a-date')).toBe('not-a-date')
  })
})
