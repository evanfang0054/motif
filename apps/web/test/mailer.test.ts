import { describe, expect, it } from 'vitest'
import { ConsoleMailer, ResendMailer, SendGridMailer, SmtpMailer, createMailerFromEnv } from '../src/server/mailer'

describe('createMailerFromEnv', () => {
  it('默认 console（本地直出）', () => {
    const cfg = createMailerFromEnv({})
    expect(cfg.mailer instanceof ConsoleMailer).toBe(true)
    expect(cfg.isConsole).toBe(true)
  })
  it('smtp 缺配置直接报错并列出缺失键', () => {
    expect(() => createMailerFromEnv({ MOTIF_MAILER: 'smtp' })).toThrow(/SMTP_HOST/)
  })
  it('smtp 配置齐全时创建 SmtpMailer（465 端口默认 SSL）', () => {
    const cfg = createMailerFromEnv({
      MOTIF_MAILER: 'smtp',
      SMTP_HOST: 'smtp.qq.com',
      SMTP_PORT: '465',
      SMTP_USER: 'a@qq.com',
      SMTP_PASS: 'authcode',
      MAIL_FROM: 'a@qq.com',
    })
    expect(cfg.mailer instanceof SmtpMailer).toBe(true)
    expect(cfg.isConsole).toBe(false)
  })
  it('resend / sendgrid 缺 Key 报错，齐全时创建对应实现', () => {
    expect(() => createMailerFromEnv({ MOTIF_MAILER: 'resend' })).toThrow(/RESEND_API_KEY/)
    expect(() => createMailerFromEnv({ MOTIF_MAILER: 'sendgrid' })).toThrow(/SENDGRID_API_KEY/)
    expect(
      createMailerFromEnv({ MOTIF_MAILER: 'resend', RESEND_API_KEY: 're_x', MAIL_FROM: 'a@b.co' }).mailer instanceof
        ResendMailer
    ).toBe(true)
    expect(
      createMailerFromEnv({ MOTIF_MAILER: 'sendgrid', SENDGRID_API_KEY: 'sg_x', MAIL_FROM: 'a@b.co' }).mailer instanceof
        SendGridMailer
    ).toBe(true)
  })
})

describe('SMTP / API 发信载荷', () => {
  it('SmtpMailer 组装收件人、主题与正文', async () => {
    const sent: Array<Record<string, unknown>> = []
    const mailer = new SmtpMailer(
      { host: 'smtp.qq.com', port: 465, secure: true, user: 'a@qq.com', pass: 'auth', from: 'a@qq.com' },
      (opts) =>
        ({
          sendMail: async (mail: Record<string, unknown>) => {
            sent.push(mail)
            return {}
          },
        }) as never
    )
    await mailer.sendVerificationCode('user@b.co', '123456', 'register')
    const mail = sent[0] as { to: string; subject: string; html: string }
    expect(mail.to).toBe('user@b.co')
    expect(mail.subject).toContain('123456')
    expect(mail.html).toContain('123456')
    expect(mail.html).toContain('注册 Motif 账号')
  })

  it('ResendMailer 走官方 API 并携带 Bearer Key', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchFn = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ id: 'x' }), { status: 200 })
    }) as unknown as (url: string, init?: RequestInit) => Promise<Response>
    const mailer = new ResendMailer('re_key', 'Motif <a@b.co>', fetchFn)
    await mailer.sendVerificationCode('user@b.co', '654321', 'password-reset')
    expect(calls[0].url).toBe('https://api.resend.com/emails')
    const body = JSON.parse(String(calls[0].init?.body))
    expect(body.to).toEqual(['user@b.co'])
    expect(body.html).toContain('654321')
    const headers = calls[0].init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer re_key')
  })

  it('SendGridMailer 走 v3 mail/send', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchFn = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return new Response('', { status: 202 })
    }) as unknown as (url: string, init?: RequestInit) => Promise<Response>
    const mailer = new SendGridMailer('sg_key', 'a@b.co', fetchFn)
    await mailer.sendVerificationCode('user@b.co', '111222', 'register')
    expect(calls[0].url).toBe('https://api.sendgrid.com/v3/mail/send')
    expect(JSON.parse(String(calls[0].init?.body)).personalizations[0].to[0].email).toBe('user@b.co')
  })

  it('API 失败抛出含状态码异常', async () => {
    const fetchFn = (async () => new Response('bad key', { status: 401 })) as unknown as (
      url: string,
      init?: RequestInit
    ) => Promise<Response>
    const mailer = new ResendMailer('bad', 'a@b.co', fetchFn)
    await expect(mailer.sendVerificationCode('u@b.co', '123456', 'register')).rejects.toThrow(/401/)
  })
})
