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

/** 支付渠道引导卡：与邮件侧同构（epay 只教方法不背书具体站点；Stripe 强调 test→live 的双替换） */
export const PAYMENT_GUIDES: Record<'epay' | 'stripe', GuideCard[]> = {
  epay: [
    {
      id: 'epay-howto',
      title: '易支付协议网关（三件套即可接入）',
      steps: [
        '易支付是「协议」不是某家公司：任何遵循易支付协议的聚合网关都可用',
        '在你选定的网关站点注册商户账号（自行评估站点资质与风险）',
        '在商户后台拿到三样：网关地址、商户 ID（PID）、商户密钥（KEY）',
        '回到本页填入三个字段并保存，再到下方危险区把支付渠道切到 epay',
      ],
      linkUrl: 'https://github.com/Calcium-Ion/go-epay',
      linkLabel: '查看协议参考实现',
      // ⚠️ 前缀是有意保留的：它承载「这是警告」的语义，而数据里只有这一条是警告
      // （渲染成图标要给 GuideCard 加字段）。属文案/数据里的 emoji 而非控件图标，不在本次范围。
      note: '⚠️ 易支付网关基本仅支持 CNY 结算；站点良莠不齐，请自行尽调，Motif 不背书任何站点。',
    },
  ],
  stripe: [
    {
      id: 'stripe-keys',
      title: 'Stripe（支持 test mode 免费全链路验证）',
      steps: [
        '注册 dashboard.stripe.com',
        'Developers → API keys：复制 Secret key（sk_test_… 先用测试密钥）',
        'Developers → Webhooks → Add endpoint：地址填 https://你的域名/api/billing/webhook/stripe，事件勾选 checkout.session.completed，复制签名密钥 whsec_…（test 模式在 /test/webhooks 页获取，前缀同为 whsec_）',
        '回到本页填入两把密钥并保存，再到下方危险区把支付渠道切到 stripe',
        'test 全链路验证通过后切 live：Dashboard 切到 live 视图重新 Add endpoint（同样勾选 checkout.session.completed），把 sk_live_… 与新端点的 whsec_… 一并替换保存——只换 key 不换 whsec 会让真实付款全部验签失败、付了钱不到账',
      ],
      linkUrl: 'https://dashboard.stripe.com/apikeys',
      linkLabel: '打开 Stripe API Keys',
      note: '用 4242 4242 4242 4242 测试卡即可在 test mode 完成真实流程验证。',
    },
  ],
}
