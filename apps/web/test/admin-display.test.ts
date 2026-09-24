import { describe, expect, it } from 'vitest'
import { userBriefMap, userDisplayLabel } from '@/lib/admin-display'
import { enumDisplayValue } from '@/lib/settings-draft'
import { describeAdminError } from '@/lib/admin-error'
import { ApiError } from '@/lib/client'

/**
 * 管理端展示层三个纯函数的用例（#75-3.1 / #75-3.3 / #79-1.3）。
 *
 * 这几处都曾有「形式改了、语义没达成」的风险：
 *  - 用户列：把 ID 换成标签，但摘要缺失时若返回空串，整行看起来像坏了
 *  - 错误文案：把英文换成中文，但把服务端**具体的**中文原因也一起换掉就没价值了
 *  - 枚举回显：把默认值填进下拉，但若默认值不是合法选项，会显示成空白（更难排查）
 */

describe('userDisplayLabel：把 usr_ ID 显示成人', () => {
  it('有昵称与邮箱时拼成「昵称（邮箱）」', () => {
    expect(userDisplayLabel({ id: 'usr_1', name: '张三', email: 'z@b.co' }, 'usr_1')).toBe('张三（z@b.co）')
  })

  it('昵称等于邮箱时只显示一次（引导创建的账号 name 就是邮箱）', () => {
    expect(userDisplayLabel({ id: 'usr_1', name: 'a@b.co', email: 'a@b.co' }, 'usr_1')).toBe('a@b.co')
  })

  it('摘要缺失时退回裸 ID —— 不显示空串，保住可追溯性', () => {
    expect(userDisplayLabel(undefined, 'usr_abc')).toBe('usr_abc')
    expect(userDisplayLabel(null, 'usr_abc')).toBe('usr_abc')
  })

  it('只有昵称或只有邮箱时用其中一个，不出现空括号', () => {
    expect(userDisplayLabel({ id: 'usr_1', name: '张三', email: '' }, 'usr_1')).toBe('张三')
    expect(userDisplayLabel({ id: 'usr_1', name: '', email: 'z@b.co' }, 'usr_1')).toBe('z@b.co')
    expect(userDisplayLabel({ id: 'usr_1', name: '  ', email: '  ' }, 'usr_1')).toBe('usr_1')
  })
})

describe('userBriefMap：把接口返回的摘要数组收成 Map', () => {
  it('按 id 建索引', () => {
    const m = userBriefMap([
      { id: 'usr_1', name: '甲', email: 'a@b.co' },
      { id: 'usr_2', name: '乙', email: 'b@b.co' },
    ])
    expect(m.get('usr_2')?.name).toBe('乙')
    expect(m.get('usr_3')).toBeUndefined()
  })

  it('undefined / 空数组给空 Map（调用方不必再判空）', () => {
    expect(userBriefMap(undefined).size).toBe(0)
    expect(userBriefMap([]).size).toBe(0)
  })
})

describe('enumDisplayValue：枚举下拉回显当前生效值', () => {
  const mailer = { value: null, defaultHint: 'console', options: ['console', 'smtp', 'resend', 'sendgrid'] }

  it('已设置时回显已设置的值，不标默认', () => {
    expect(enumDisplayValue({ ...mailer, value: 'smtp' })).toEqual({ value: 'smtp', fromDefault: false })
  })

  it('未设置时回显 defaultHint 并标为「来自默认」（此前只显示占位符）', () => {
    expect(enumDisplayValue(mailer)).toEqual({ value: 'console', fromDefault: true })
  })

  it('defaultHint 不是合法选项时**不回填**（否则下拉显示空白，更难排查）', () => {
    expect(enumDisplayValue({ value: null, defaultHint: 'nope', options: ['console', 'smtp'] })).toEqual({
      value: null,
      fromDefault: false,
    })
  })

  it('没有 defaultHint / 没有 options 时保持原样', () => {
    expect(enumDisplayValue({ value: null, defaultHint: null, options: ['a'] })).toEqual({ value: null, fromDefault: false })
    expect(enumDisplayValue({ value: null, defaultHint: 'a', options: null })).toEqual({ value: null, fromDefault: false })
  })

  it('空串按「未设置」处理（与存储层 null 同义）', () => {
    expect(enumDisplayValue({ ...mailer, value: '' })).toEqual({ value: 'console', fromDefault: true })
  })
})

describe('describeAdminError：错误文案不透传英文原文', () => {
  it('401 且服务端给了中文原因时先透传（「未登录」不等于「登录已过期」）', () => {
    expect(describeAdminError(new ApiError(401, '请先登录。'))).toBe('请先登录。')
  })

  it('401 且只有框架英文原文时才换成「登录已过期」这一可行动提示', () => {
    expect(describeAdminError(new ApiError(401, 'Unauthorized'))).toBe('登录已过期，请重新登录。')
    expect(describeAdminError(new ApiError(401, ''))).toBe('登录已过期，请重新登录。')
  })

  it('保留服务端的中文业务原因（403 的具体理由不能丢）', () => {
    expect(describeAdminError(new ApiError(403, '管理员不可调整超级管理员的额度。'))).toBe('管理员不可调整超级管理员的额度。')
  })

  it('403 的英文原文（框架默认 Forbidden）换成中文指引', () => {
    expect(describeAdminError(new ApiError(403, 'Forbidden'))).toContain('没有权限')
  })

  it('其它状态码的非中文文案给中文兜底，不回显英文', () => {
    const msg = describeAdminError(new ApiError(500, 'Internal Server Error'))
    expect(msg).toContain('500')
    expect(msg).not.toContain('Internal Server Error')
  })

  it('网络层异常（浏览器英文原文）换成中文', () => {
    expect(describeAdminError(new TypeError('Failed to fetch'))).toBe('网络异常，请检查网络后重试。')
    expect(describeAdminError(new TypeError('Failed to fetch'))).not.toContain('Failed to fetch')
  })

  it('非 ApiError 的普通 Error（即便带中文）也归为「网络异常」—— 与通用 errorMessage 的刻意分工', () => {
    // 管理页只调 api.*：不是 ApiError 的抛出就是传输层故障；而通用 errorMessage 必须透传中文
    //（画布归档解析等纯函数故意抛中文 Error），两者判据不同，此处钉住管理端这一侧。
    expect(describeAdminError(new Error('读取失败：不是合法的 zip（找不到中央目录结尾记录）。'))).toBe(
      '网络异常，请检查网络后重试。'
    )
  })

  it('非 Error 的未知抛出也给中文兜底', () => {
    expect(describeAdminError('boom')).toBe('操作失败，请稍后重试。')
    expect(describeAdminError(undefined)).toBe('操作失败，请稍后重试。')
  })
})
