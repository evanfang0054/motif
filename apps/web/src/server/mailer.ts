import nodemailer, { type Transporter, type TransportOptions } from 'nodemailer'
import { ConfigError } from './config-error'

/**
 * 邮件发送抽象：验证码等系统邮件的统一出口。
 * MOTIF_MAILER=console（默认，本地直出）| smtp（QQ/163/Gmail 等通用 SMTP）| resend | sendgrid
 */

export type MailPurpose = 'register' | 'password-reset'

export interface Mailer {
  readonly name: string
  sendVerificationCode(to: string, code: string, purpose: MailPurpose): Promise<void>
  /** 管理后台测试发送：发一封纯文本测试邮件，失败原样抛底层错误（如 SMTP 535 授权码错误） */
  sendTest(to: string): Promise<void>
}

const TEST_EMAIL_TEXT = '这是一封来自 Motif 管理后台的测试邮件。收到即说明发信配置正确。'

const PURPOSE_TEXT: Record<MailPurpose, string> = {
  register: '注册 Motif 账号',
  'password-reset': '重置 Motif 密码',
}

function codeEmailHtml(code: string, purpose: MailPurpose): string {
  return `<div style="font-family:Arial,'PingFang SC','Microsoft YaHei',sans-serif;max-width:520px;margin:0 auto;padding:24px;">
  <h2 style="color:#131311;margin:0 0 8px;">Motif 验证码</h2>
  <p style="color:#52525b;font-size:14px;margin:0 0 16px;">你正在${PURPOSE_TEXT[purpose]}，本次验证码为：</p>
  <div style="font-size:32px;font-weight:800;letter-spacing:8px;color:#131311;background:#f3efe6;border-radius:12px;padding:16px;text-align:center;">${code}</div>
  <p style="color:#9ca3af;font-size:12px;margin-top:16px;">验证码 10 分钟内有效，请勿泄露给他人。若非本人操作，请忽略本邮件。</p>
</div>`
}

/** 本地开发：验证码只打日志（配合 MOTIF_EXPOSE_DEV_CODE 在页面直出） */
export class ConsoleMailer implements Mailer {
  readonly name = 'console'

  async sendVerificationCode(to: string, code: string, purpose: MailPurpose): Promise<void> {
    console.log(`[motif] ${purpose} 验证码已生成 → ${to}: ${code}`)
  }

  async sendTest(to: string): Promise<void> {
    console.log(`[mailer:test] 测试邮件已发往 ${to}（console 渠道仅打日志）`)
  }
}

/** 通用 SMTP：QQ 邮箱 / 163 / Gmail / 企业邮箱等 */
export class SmtpMailer implements Mailer {
  readonly name = 'smtp'
  private transporter: Transporter

  constructor(
    private config: { host: string; port: number; secure: boolean; user: string; pass: string; from: string },
    transportFactory: (opts: Record<string, unknown>) => Transporter = (opts) =>
      nodemailer.createTransport(opts as TransportOptions)
  ) {
    this.transporter = transportFactory({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: { user: config.user, pass: config.pass },
    })
  }

  async sendVerificationCode(to: string, code: string, purpose: MailPurpose): Promise<void> {
    await this.transporter.sendMail({
      from: `"Motif" <${this.config.from}>`,
      to,
      subject: `Motif 验证码：${code}`,
      html: codeEmailHtml(code, purpose),
      text: `你正在${PURPOSE_TEXT[purpose]}，验证码 ${code}，10 分钟内有效。`,
    })
  }

  async sendTest(to: string): Promise<void> {
    await this.transporter.sendMail({
      from: `"Motif" <${this.config.from}>`,
      to,
      subject: 'Motif 测试邮件',
      text: TEST_EMAIL_TEXT,
    })
  }
}

/** Resend（https://resend.com，HTTP API） */
export class ResendMailer implements Mailer {
  readonly name = 'resend'

  constructor(
    private apiKey: string,
    private from: string,
    private fetchFn: (url: string, init?: RequestInit) => Promise<Response> = fetch
  ) {}

  async sendVerificationCode(to: string, code: string, purpose: MailPurpose): Promise<void> {
    const res = await this.fetchFn('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: this.from,
        to: [to],
        subject: `Motif 验证码：${code}`,
        html: codeEmailHtml(code, purpose),
      }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Resend 发信失败（${res.status}）：${text.slice(0, 200)}`)
    }
  }

  async sendTest(to: string): Promise<void> {
    const res = await this.fetchFn('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: this.from,
        to: [to],
        subject: 'Motif 测试邮件',
        text: TEST_EMAIL_TEXT,
      }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Resend 发信失败（${res.status}）：${text.slice(0, 200)}`)
    }
  }
}

/** SendGrid（HTTP API，v3 mail/send） */
export class SendGridMailer implements Mailer {
  readonly name = 'sendgrid'

  constructor(
    private apiKey: string,
    private from: string,
    private fetchFn: (url: string, init?: RequestInit) => Promise<Response> = fetch
  ) {}

  async sendVerificationCode(to: string, code: string, purpose: MailPurpose): Promise<void> {
    const res = await this.fetchFn('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: this.from },
        subject: `Motif 验证码：${code}`,
        content: [{ type: 'text/html', value: codeEmailHtml(code, purpose) }],
      }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`SendGrid 发信失败（${res.status}）：${text.slice(0, 200)}`)
    }
  }

  async sendTest(to: string): Promise<void> {
    const res = await this.fetchFn('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: this.from },
        subject: 'Motif 测试邮件',
        content: [{ type: 'text/plain', value: TEST_EMAIL_TEXT }],
      }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`SendGrid 发信失败（${res.status}）：${text.slice(0, 200)}`)
    }
  }
}

/**
 * 配置不完整时的占位发信器：**构造不抛错，抛错推迟到真正发信时**。
 *
 * 为什么必须容忍：发信配置写坏（例如选了 smtp 却没填密码）不该让整个进程起不来 ——
 * 否则运维连设置页都打不开，也就无法把配置改回来。
 * 调用方需保证 isConsole 为 false：配置坏了更不能把验证码直出回传给调用方。
 *
 * 抛 `ConfigError` 而非普通 Error：注册链路里没人包 try/catch，普通 Error 会被
 * `jsonError` 归一成「服务器开小差了」，运营只能翻日志才查得出是配置问题。
 *
 * 注：`sendTest` 的 ConfigError 在 HTTP 层是**无效**的 —— `sendTestMail` 会先把它包成
 * `ServiceError(502)` 并原样透传底层原因（管理后台调试需要看到 SMTP 535 之类的原文）。
 * 这里仍抛同一类型，只为「配置失败就是配置失败」这一语义一致。
 */
export class MisconfiguredMailer implements Mailer {
  readonly name = 'misconfigured'

  constructor(private readonly reason: string) {}

  async sendVerificationCode(): Promise<never> {
    throw new ConfigError(this.reason)
  }

  async sendTest(): Promise<never> {
    throw new ConfigError(this.reason)
  }
}

export type MailerConfig = {
  mailer: Mailer
  /** console 直出模式下，验证码可随接口回传（本地联调） */
  isConsole: boolean
}

/**
 * 发信配置的取值表。刻意用 `Record<string, string | undefined>` 而不是 `NodeJS.ProcessEnv` ——
 * 配置来源已经从「环境变量」变成「数据库优先、回退 env」，而构造逻辑一行都不该变。
 */
export type MailerConfigValues = Record<string, string | undefined>

/** 从取值表选择发信实现；选了真实渠道但配置不全时直接抛错（快速暴露配置问题） */
export function createMailerFromConfig(env: MailerConfigValues): MailerConfig {
  const choice = (env.MOTIF_MAILER || 'console').toLowerCase()
  const from = env.MAIL_FROM
  switch (choice) {
    case 'smtp': {
      const missing = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM'].filter((k) => !env[k])
      if (missing.length) throw new Error(`[motif] MOTIF_MAILER=smtp 缺少配置：${missing.join(', ')}`)
      return {
        mailer: new SmtpMailer({
          host: env.SMTP_HOST!,
          port: Number(env.SMTP_PORT),
          secure: env.SMTP_SECURE ? env.SMTP_SECURE !== 'false' : Number(env.SMTP_PORT) === 465,
          user: env.SMTP_USER!,
          pass: env.SMTP_PASS!,
          from: from!,
        }),
        isConsole: false,
      }
    }
    case 'resend': {
      if (!env.RESEND_API_KEY || !from) throw new Error('[motif] MOTIF_MAILER=resend 缺少配置：RESEND_API_KEY, MAIL_FROM')
      return { mailer: new ResendMailer(env.RESEND_API_KEY, from), isConsole: false }
    }
    case 'sendgrid': {
      if (!env.SENDGRID_API_KEY || !from) throw new Error('[motif] MOTIF_MAILER=sendgrid 缺少配置：SENDGRID_API_KEY, MAIL_FROM')
      return { mailer: new SendGridMailer(env.SENDGRID_API_KEY, from), isConsole: false }
    }
    default:
      return { mailer: new ConsoleMailer(), isConsole: true }
  }
}

/** 兼容入口：等价于把 process.env 当取值表传进去 */
export function createMailerFromEnv(env: NodeJS.ProcessEnv = process.env): MailerConfig {
  return createMailerFromConfig(env)
}
