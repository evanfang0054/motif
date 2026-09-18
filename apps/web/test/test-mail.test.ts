import { describe, expect, it, vi } from 'vitest'
import { MisconfiguredMailer } from '@/server/mailer'
import { sendTestMail, ServiceError } from '@/server/services'
import type { Mailer, MailerConfig } from '@/server/mailer'

const fakeConfig = (mailer: Mailer): MailerConfig => ({ mailer, isConsole: false })

describe('sendTestMail', () => {
  it('调用当前渠道的 sendTest 并返回渠道名', async () => {
    const sendTest = vi.fn(async () => {})
    const r = await sendTestMail(fakeConfig({ name: 'smtp', sendTest }), 'ops@example.com')
    expect(sendTest).toHaveBeenCalledWith('ops@example.com')
    expect(r).toEqual({ ok: true, via: 'smtp' })
  })

  it('邮箱格式非法 → 400', async () => {
    await expect(sendTestMail(fakeConfig({ name: 'smtp', sendTest: async () => {} }), 'bad-mail')).rejects.toThrow(ServiceError)
  })

  it('同邮箱 60 秒内第二封被频控（429）', async () => {
    const cfg = fakeConfig({ name: 'smtp', sendTest: async () => {} })
    await sendTestMail(cfg, 'freq@example.com')
    await expect(sendTestMail(cfg, 'freq@example.com')).rejects.toThrow(/频繁/)
  })

  it('渠道底层错误原样冒泡（页面透传 535 等原因）', async () => {
    const boom = async () => {
      throw new Error('SMTP 535 授权码错误')
    }
    await expect(sendTestMail(fakeConfig({ name: 'smtp', sendTest: boom }), 'boom@example.com')).rejects.toThrow('535')
  })

  it('发送失败包装为 ServiceError(502)——HTTP 层经 jsonError 直达页面而非 500 通用文案', async () => {
    const boom = async () => {
      throw new Error('SMTP 535 授权码错误')
    }
    try {
      await sendTestMail(fakeConfig({ name: 'smtp', sendTest: boom }), 'wrap@example.com')
      expect.unreachable('应当抛出 ServiceError')
    } catch (e) {
      expect(e).toBeInstanceOf(ServiceError)
      expect((e as ServiceError).status).toBe(502)
      expect((e as ServiceError).message).toContain('535')
    }
  })

  it('MisconfiguredMailer 抛错 → ServiceError 400', async () => {
    const bad = new MisconfiguredMailer('发信渠道未配置')
    await expect(sendTestMail(fakeConfig(bad), 'misconfig@example.com')).rejects.toThrow('未配置')
  })
})
