import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MotifStore } from '@motif/db'
import { buildResetLink, sendCode } from '@/server/services'
import { ConsoleMailer, ResendMailer, SendGridMailer, SmtpMailer, type MailerConfig } from '@/server/mailer'

/**
 * 找回密码的**邮件直达链接**（issue #21）。
 *
 * 三件要钉住的事：
 * 1. 链接拼装口径（末尾斜杠、需转义的邮箱、站点地址缺失 → null）
 * 2. 缺 `SITE_URL` 时**降级为只发码**，绝不报错、绝不阻断重置
 * 3. 注册验证码**不带链接**（只有找回密码才有深链语义）
 */
describe('buildResetLink：链接拼装口径', () => {
  it('正常拼接：站点地址 + reset/email/code 三个参数', () => {
    expect(buildResetLink('https://motif.example.com', 'a@b.co', '123456')).toBe(
      'https://motif.example.com/?reset=1&email=a%40b.co&code=123456'
    )
  })

  it('站点地址末尾多斜杠时不会拼出双斜杠', () => {
    expect(buildResetLink('https://motif.example.com///', 'a@b.co', '123456')).toBe(
      'https://motif.example.com/?reset=1&email=a%40b.co&code=123456'
    )
  })

  it('邮箱做 URL 编码（`@` 与 `+` 这类字符不能原样进 query）', () => {
    const link = buildResetLink('https://x.io', 'a+b@c.co', '000111')!
    expect(link).toContain('email=a%2Bb%40c.co')
    expect(link).not.toContain('a+b@c.co')
  })

  it('⚠️ 站点地址为空 / 只有空白 / undefined → null（降级，不是拼个半成品）', () => {
    expect(buildResetLink(undefined, 'a@b.co', '123456')).toBeNull()
    expect(buildResetLink('', 'a@b.co', '123456')).toBeNull()
    expect(buildResetLink('   ', 'a@b.co', '123456')).toBeNull()
  })

  it('反证：站点地址非空时必须给出链接（否则上面的 null 断言会假绿）', () => {
    expect(buildResetLink('https://x.io', 'a@b.co', '1')).not.toBeNull()
  })
})

describe('mailer 各渠道把链接渲染进正文', () => {
  const LINK = 'https://motif.example.com/?reset=1&email=a%40b.co&code=123456'
  /** HTML 上下文里 `&` 必须写成实体，否则会把 query 截断成 `reset=1` */
  const LINK_HTML = LINK.replace(/&/g, '&amp;')

  /** 记下每次 sendMail 的入参，用来断言发出去的正文长什么样 */
  function smtpRecorder(sent: Array<Record<string, unknown>>): SmtpMailer {
    return new SmtpMailer(
      { host: 'h', port: 465, secure: true, user: 'u', pass: 'p', from: 'f@x.io' },
      () => ({ sendMail: async (o: Record<string, unknown>) => void sent.push(o) }) as never
    )
  }

  it('console 渠道把链接打到日志（本地联调不必手拼）', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await new ConsoleMailer().sendVerificationCode('a@b.co', '123456', 'password-reset', LINK)
    expect(spy.mock.calls.flat().join(' ')).toContain(LINK)
    spy.mockRestore()
  })

  it('SMTP：有链接时 html（转义后）与 text（原文）都带上', async () => {
    const sent: Array<Record<string, unknown>> = []
    await smtpRecorder(sent).sendVerificationCode('a@b.co', '123456', 'password-reset', LINK)
    expect(String(sent[0].html)).toContain(LINK_HTML)
    // 纯文本部分不是 HTML 上下文，保持原文（用户要能直接复制粘贴）
    expect(String(sent[0].text)).toContain(LINK)
  })

  it('SMTP：**没有**链接时正文与改造前一致（不含 href / 不含链接文案）', async () => {
    const sent: Array<Record<string, unknown>> = []
    await smtpRecorder(sent).sendVerificationCode('a@b.co', '123456', 'register')
    expect(String(sent[0].html)).not.toContain('href=')
    expect(String(sent[0].html)).not.toContain('前往重置密码')
    expect(String(sent[0].text)).toBe('你正在注册 Motif 账号，验证码 123456，10 分钟内有效。')
  })

  it('⚠️ 链接里的引号被转义 —— 突破不了 href 属性边界（SITE_URL 是管理员可配的）', async () => {
    // 反证对象：不转义时 `href="…" onmouseover="…"` 会凭空多出一个属性，在用户邮件里注入事件/第二个链接
    const nasty = 'https://x.io/?a=" onmouseover="alert(1)'
    const sent: Array<Record<string, unknown>> = []
    await smtpRecorder(sent).sendVerificationCode('a@b.co', '123456', 'password-reset', nasty)
    const html = String(sent[0].html)
    expect(html).not.toContain('" onmouseover="')
    expect(html).not.toContain(nasty)
    expect(html).toContain('&quot;')
  })

  it('Resend：body.html 与 body.text 都带上链接', async () => {
    const calls: Array<{ body: string }> = []
    const m = new ResendMailer('k', 'f@x.io', async (_url, init) => {
      calls.push({ body: String(init?.body) })
      return new Response('{}', { status: 200 })
    })
    await m.sendVerificationCode('a@b.co', '123456', 'password-reset', LINK)
    const body = JSON.parse(calls[0].body) as { html: string; text: string }
    expect(body.html).toContain(LINK_HTML)
    expect(body.text).toContain(LINK)
  })

  it('SendGrid：content 里同时有 text/plain 与 text/html 两个 part', async () => {
    const calls: Array<{ body: string }> = []
    const m = new SendGridMailer('k', 'f@x.io', async (_url, init) => {
      calls.push({ body: String(init?.body) })
      return new Response('{}', { status: 200 })
    })
    await m.sendVerificationCode('a@b.co', '123456', 'password-reset', LINK)
    const body = JSON.parse(calls[0].body) as { content: Array<{ type: string; value: string }> }
    expect(body.content.map((c) => c.type)).toEqual(['text/plain', 'text/html'])
    expect(body.content.find((c) => c.type === 'text/html')!.value).toContain(LINK_HTML)
    expect(body.content.find((c) => c.type === 'text/plain')!.value).toContain(LINK)
  })
})

describe('sendCode 的降级与作用域（走真 store）', () => {
  let dir: string
  let store: MotifStore
  /** 记录每次发信收到的 link，用来断言「发没发链接」 */
  let seen: Array<string | undefined>

  function mailerRecorder(): MailerConfig {
    const mailer = {
      name: 'recorder',
      async sendVerificationCode(_to: string, _code: string, _purpose: string, link?: string) {
        seen.push(link)
      },
      async sendTest() {},
    }
    return { mailer: mailer as never, isConsole: false }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'motif-resetlink-'))
    store = new MotifStore(join(dir, 'motif.db'))
    seen = []
    // 清掉限流状态：同一邮箱 60s 冷却会让第二个用例直接 429
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })
  afterEach(() => {
    vi.useRealTimers()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('配了 SITE_URL → 找回密码邮件带链接', async () => {
    store.setSetting('SITE_URL', 'https://motif.example.com')
    await sendCode(store, mailerRecorder(), 'password-reset', 'a@b.co')
    expect(seen[0]).toMatch(/^https:\/\/motif\.example\.com\/\?reset=1&email=a%40b\.co&code=\d{6}$/)
  })

  it('⚠️ 未配 SITE_URL → 不发链接，但**不报错、验证码照常发**（降级）', async () => {
    await expect(sendCode(store, mailerRecorder(), 'password-reset', 'b@b.co')).resolves.toMatchObject({ sent: true })
    expect(seen).toEqual([undefined])
  })

  it('注册验证码即便配了 SITE_URL 也不带链接（深链只属于找回密码）', async () => {
    store.setSetting('SITE_URL', 'https://motif.example.com')
    await sendCode(store, mailerRecorder(), 'register', 'c@b.co')
    expect(seen).toEqual([undefined])
  })

  it('链接里的验证码与库中刚生成的码一致（不是另一个码）', async () => {
    store.setSetting('SITE_URL', 'https://motif.example.com')
    const r = await sendCode(store, mailerRecorder(), 'password-reset', 'd@b.co')
    // console 之外不回传 devCode，这里用「链接里的码能通过校验」来证同一性
    const codeInLink = seen[0]!.match(/code=(\d{6})/)![1]
    expect(r.sent).toBe(true)
    expect(store.consumeVerificationCode('password-reset', 'd@b.co', codeInLink)).toBe(true)
  })
})
