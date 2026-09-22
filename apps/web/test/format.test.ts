import { describe, expect, it } from 'vitest'
import { formatDateTime, formatMoney } from '@/lib/format'

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

describe('formatMoney（分 → 带币种符号的两位小数）', () => {
  it('已知币种用符号，且大小写不敏感', () => {
    expect(formatMoney(868, 'hkd')).toBe('HK$8.68')
    expect(formatMoney(868, 'HKD')).toBe('HK$8.68')
    expect(formatMoney(100, 'cny')).toBe('¥1.00')
    expect(formatMoney(100, 'usd')).toBe('US$1.00')
  })

  it('未知币种退化为 ISO 代码（带空格，避免与数字粘连）', () => {
    expect(formatMoney(100, 'sek')).toBe('SEK 1.00')
  })

  it('币种缺失/空白：只出数字，不留前导空格', () => {
    expect(formatMoney(100, '')).toBe('1.00')
    expect(formatMoney(100, '   ')).toBe('1.00')
    expect(formatMoney(100, null as unknown as string)).toBe('1.00')
  })

  it('零与不足一元都补齐两位小数', () => {
    expect(formatMoney(0, 'hkd')).toBe('HK$0.00')
    expect(formatMoney(5, 'hkd')).toBe('HK$0.05')
  })
})
