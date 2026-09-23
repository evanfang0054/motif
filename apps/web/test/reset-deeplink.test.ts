import { describe, expect, it } from 'vitest'
import { parseResetParams } from '@/lib/reset-link'

/**
 * 找回密码深链的参数解析（issue #21）。
 *
 * 关键不变量：**宁可返回 null（退化为手工输入），也不预填一个不可能合法的值** ——
 * 预填垃圾只会让用户提交后收到「验证码无效」而不知为何。
 */
describe('parseResetParams：什么算合法深链', () => {
  const ok = { reset: '1', email: 'a@b.co', code: '123456' }

  it('三参数齐全且形状正确 → 返回预填值', () => {
    expect(parseResetParams(ok)).toEqual({ email: 'a@b.co', code: '123456' })
  })

  it('两侧空白被裁掉（邮件客户端偶尔会带空白）', () => {
    expect(parseResetParams({ reset: ' 1 ', email: ' a@b.co ', code: ' 123456 ' })).toEqual({
      email: 'a@b.co',
      code: '123456',
    })
  })

  it('⚠️ 缺 reset=1 就不认（避免任何带 email/code 的链接都能触发重置弹窗）', () => {
    expect(parseResetParams({ email: 'a@b.co', code: '123456' })).toBeNull()
    expect(parseResetParams({ reset: '0', email: 'a@b.co', code: '123456' })).toBeNull()
    expect(parseResetParams({ reset: 'true', email: 'a@b.co', code: '123456' })).toBeNull()
  })

  it('缺 email 或 code → null（不半预填）', () => {
    expect(parseResetParams({ reset: '1', code: '123456' })).toBeNull()
    expect(parseResetParams({ reset: '1', email: 'a@b.co' })).toBeNull()
    expect(parseResetParams({ reset: '1', email: '', code: '' })).toBeNull()
  })

  it('⚠️ 验证码必须是 6 位数字 —— 形状不对就退化为手工输入，而不是把垃圾填进输入框', () => {
    expect(parseResetParams({ ...ok, code: '12345' })).toBeNull()
    expect(parseResetParams({ ...ok, code: '1234567' })).toBeNull()
    expect(parseResetParams({ ...ok, code: 'abcdef' })).toBeNull()
    expect(parseResetParams({ ...ok, code: '12345a' })).toBeNull()
  })

  it('邮箱形状不对 → null', () => {
    expect(parseResetParams({ ...ok, email: 'not-an-email' })).toBeNull()
    expect(parseResetParams({ ...ok, email: 'a@b' })).toBeNull()
  })

  it('同名参数出现多次时取第一个（不依赖实现细节）', () => {
    expect(parseResetParams({ reset: '1', email: ['a@b.co', 'c@d.co'], code: ['123456', '654321'] })).toEqual({
      email: 'a@b.co',
      code: '123456',
    })
  })

  it('空取值表 / undefined 值 → null（不抛错）', () => {
    expect(parseResetParams({})).toBeNull()
    expect(parseResetParams({ reset: undefined, email: undefined, code: undefined })).toBeNull()
  })

  it('反证：合法输入必须给出非 null（否则上面那批 null 断言会假绿）', () => {
    expect(parseResetParams(ok)).not.toBeNull()
  })
})
