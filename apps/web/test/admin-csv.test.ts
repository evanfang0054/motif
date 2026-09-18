import { describe, expect, it } from 'vitest'
import { buildCdkCsv } from '@/lib/admin-csv'

describe('CDK 导出 CSV', () => {
  it('表头与数据行数正确，空值渲染为空字段', () => {
    const csv = buildCdkCsv([
      { code: 'MOTIF-AAA', credits: 10, status: '未兑换', redeemedBy: null, redeemedAt: null, revokedAt: null, createdAt: '2026-09-18T00:00:00.000Z' },
      { code: 'MOTIF-BBB', credits: 20, status: '已兑换', redeemedBy: 'usr_1', redeemedAt: '2026-09-18T01:00:00.000Z', revokedAt: null, createdAt: '2026-09-18T00:00:00.000Z' },
    ])
    const lines = csv.trimEnd().split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe('code,credits,status,redeemed_by,redeemed_at,revoked_at,created_at')
    expect(lines[1]).toBe('MOTIF-AAA,10,未兑换,,,,2026-09-18T00:00:00.000Z')
    expect(lines[2]).toContain('usr_1')
  })

  it('含逗号或引号的字段被正确转义', () => {
    const csv = buildCdkCsv([
      { code: 'A,B', credits: 1, status: 'x"y', redeemedBy: null, redeemedAt: null, revokedAt: null, createdAt: 't' },
    ])
    const line = csv.trimEnd().split('\n')[1]
    expect(line.startsWith('"A,B",1,"x""y"')).toBe(true)
  })

  it('空列表只输出表头', () => {
    expect(buildCdkCsv([]).trimEnd().split('\n')).toHaveLength(1)
  })
})
