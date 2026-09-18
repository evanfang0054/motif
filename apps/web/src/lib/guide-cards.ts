/** 渠道引导卡：静态内容（非配置项）。入口链接用于桌面点击、二维码用于手机扫码直达。 */
export interface GuideCard {
  id: string
  title: string
  steps: string[]
  linkUrl: string
  linkLabel: string
  note?: string
}

export const MAILER_GUIDES: Record<'smtp' | 'resend' | 'sendgrid', GuideCard[]> = {
  smtp: [
    {
      id: 'smtp-qq',
      title: 'QQ 邮箱 SMTP（推荐，国内到达稳定）',
      steps: [
        '网页登录 mail.qq.com → 设置 → 账号',
        '找到「POP3/IMAP/SMTP 服务」，开启「SMTP 服务」',
        '按提示用手机发短信获取 16 位授权码（不是 QQ 密码）',
        '回到本页：主机 smtp.qq.com、端口 465、用户名为完整邮箱、密码填授权码',
      ],
      linkUrl: 'https://wx.mail.qq.com/list/readtemplate?name=login_page.html',
      linkLabel: '打开 QQ 邮箱',
      note: '163 等其他邮箱流程相同（smtp.163.com，同样需要授权码）。',
    },
  ],
  resend: [
    {
      id: 'resend-key',
      title: 'Resend（注册即得，海外到达好）',
      steps: [
        '注册 resend.com 并登录',
        '进入 API Keys 页面，Create API Key',
        '复制以 re: 开头的密钥，粘贴到本页「Resend 密钥」',
        '发件人地址需为 Resend 已验证的域名邮箱（免费档可用 onboarding@resend.dev 试发）',
      ],
      linkUrl: 'https://dashboard.resend.com/api-keys',
      linkLabel: '打开 Resend API Keys',
      note: '免费额度每月 3000 封，足够验证码场景起步。',
    },
  ],
  sendgrid: [
    {
      id: 'sendgrid-key',
      title: 'SendGrid',
      steps: [
        '注册 sendgrid.com 并完成发件人认证',
        'Settings → API Keys → Create API Key（权限选 Mail Send）',
        '复制密钥粘贴到本页「SendGrid 密钥」',
      ],
      linkUrl: 'https://app.sendgrid.com/settings/api_keys',
      linkLabel: '打开 SendGrid API Keys',
    },
  ],
}

/** 支付侧（payment 计划 Task 10）占位：本计划不填充 */
export const PAYMENT_GUIDES_EMPTY_OK = true
