import { describe, expect, it, vi } from 'vitest'
import { MisconfiguredMailer } from '@/server/mailer'
import { ConfigError } from '@/server/config-error'
import { jsonError } from '@/server/http'
import { sendTestMail, ServiceError } from '@/server/services'
import type { Mailer, MailerConfig } from '@/server/mailer'

/** 只关心 sendTest 的替身：sendVerificationCode 给个空实现 */
const stub = (sendTest: Mailer['sendTest']): Mailer => ({
  name: 'smtp',
  sendVerificationCode: async () => {},
  sendTest,
})
const fakeConfig = (mailer: Mailer): MailerConfig => ({ mailer, isConsole: false })

describe('sendTestMail', () => {
  it('调用当前渠道的 sendTest 并返回渠道名', async () => {
    const sendTest = vi.fn(async () => {})
    const r = await sendTestMail(fakeConfig(stub(sendTest)), 'ops@example.com')
    expect(sendTest).toHaveBeenCalledWith('ops@example.com')
    expect(r).toEqual({ ok: true, via: 'smtp' })
  })

  it('邮箱格式非法 → 400', async () => {
    await expect(sendTestMail(fakeConfig(stub(async () => {})), 'bad-mail')).rejects.toThrow(ServiceError)
  })

  it('同邮箱 60 秒内第二封被频控（429）', async () => {
    const cfg = fakeConfig(stub(async () => {}))
    await sendTestMail(cfg, 'freq@example.com')
    await expect(sendTestMail(cfg, 'freq@example.com')).rejects.toThrow(/频繁/)
  })

  it('渠道底层错误原样冒泡（页面透传 535 等原因）', async () => {
    const boom = async () => {
      throw new Error('SMTP 535 授权码错误')
    }
    await expect(sendTestMail(fakeConfig(stub(boom)), 'boom@example.com')).rejects.toThrow('535')
  })

  it('发送失败包装为 ServiceError(502)——HTTP 层经 jsonError 直达页面而非 500 通用文案', async () => {
    const boom = async () => {
      throw new Error('SMTP 535 授权码错误')
    }
    try {
      await sendTestMail(fakeConfig(stub(boom)), 'wrap@example.com')
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

describe('配置类错误在 HTTP 层的出口', () => {
  it('MisconfiguredMailer 抛的是 ConfigError（而非普通 Error）', async () => {
    await expect(new MisconfiguredMailer('缺 SMTP_HOST').sendVerificationCode()).rejects.toBeInstanceOf(ConfigError)
  })

  it('jsonError 把 ConfigError 转成 503 + 中性文案，且不泄露内部键名与运维指路', async () => {
    const res = jsonError(new ConfigError('MOTIF_MAILER=smtp 缺少配置：SMTP_HOST, SMTP_PASS'))
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('服务暂时不可用')
    expect(body.error).not.toContain('SMTP_PASS') // 键名只进服务端日志
    expect(body.error).not.toContain('系统设置') // 运维指路也不给普通用户看
  })

  it('普通 Error 仍回落通用 500 文案（不误报成配置问题）', async () => {
    const res = jsonError(new Error('数据库锁住了'))
    expect(res.status).toBe(500)
    expect(((await res.json()) as { error: string }).error).toContain('服务器开小差了')
  })
})
