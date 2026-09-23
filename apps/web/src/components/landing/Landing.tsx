'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { Button } from '@heroui/react'
import { CircleCheck, Sparkles } from '@gravity-ui/icons'
import { BrandMark } from '@/components/BrandMark'
import { usePublicConfig } from '@/lib/use-public-config'
import { parseResetParams, type ResetPrefill } from '@/lib/reset-link'
import { AuthModal, type Mode } from './AuthModal'

/**
 * 「注册即送 N 张…」文案：数字随配置。函数声明有提升，故可定义在使用处之前。
 * 配置未取到时**不写数字**，避免显示一个可能已过期的 3。
 */
function SignupBonusPhrase({ tail }: { tail: string }) {
  const cfg = usePublicConfig()
  return <>{cfg ? `注册即送 ${cfg.signupBonusCredits} 张${tail}` : `注册即送${tail}`}</>
}

/** 未登录落地页：导航 + 主视觉（hero）+ 三段满幅色带 + 页脚 + 登录弹窗 */
function Landing() {
  // 弹窗模式由 Landing 持有：默认 login（回访/老用户主路径）；注册意图入口显式切 register
  const [authMode, setAuthMode] = useState<Mode>('login')
  const [authOpen, setAuthOpen] = useState(false)
  // 找回密码深链带来的预填值（只在首次进入时设一次；用户后续操作以弹窗内 state 为准）
  const [resetPrefill, setResetPrefill] = useState<ResetPrefill | null>(null)

  // URL 入口：/?mode=register（投放外链）、/?mode=login（显式登录）、/?invite=CODE（邀请自动注册）
  // 原「设模式 + 滚动到卡片」升级为「直接弹对应模式的弹窗」
  // 另：/?reset=1&email=..&code=.. 是找回密码邮件里的**直达链接**（#21）—— 自动进重置模式并预填
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    // 深链优先于 mode：邮件链接是明确的单一意图，不该被同时带的 mode 参数抢走
    const reset = parseResetParams(Object.fromEntries(params))
    if (reset) {
      setResetPrefill(reset)
      setAuthMode('reset')
      setAuthOpen(true)
      // 预填值已进 state，立刻把深链自己的三个参数从地址栏与浏览器历史里抹掉：
      // 验证码不该长期停在 URL 上（截图、转发、共用屏幕都会漏）。
      // 只删这三个参数、不动别人的（hash 也原样保留）；用 replaceState 而非 router.replace —— 页面没变，无需 RSC 往返。
      for (const k of ['reset', 'email', 'code']) params.delete(k)
      const rest = params.toString()
      const url = rest ? `${window.location.pathname}?${rest}` : window.location.pathname
      window.history.replaceState(null, '', url + window.location.hash)
      return
    }
    const mode = params.get('mode')
    if (mode === 'register' || mode === 'login') {
      setAuthMode(mode)
      setAuthOpen(true)
    }
    if (params.get('invite')) {
      setAuthMode('register')
      setAuthOpen(true)
    }
  }, [])

  /** 弹窗入口：设置模式并打开 */
  const openAuth = (m: Mode) => {
    setAuthMode(m)
    setAuthOpen(true)
  }

  /**
   * 弹窗关闭：顺手清掉深链预填值。
   * 预填只服务「从邮件点进来的那一次」—— 不清的话，之后切到注册表单会带出一个可能已过期的验证码。
   */
  const closeAuth = () => {
    setAuthOpen(false)
    setResetPrefill(null)
  }

  /** 锚点平滑滚动到色带（section）顶部：配合 scroll-margin-top 让整段模块完整入画 */
  const smoothScrollTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' })
  }

  /** 锚点 onClick 包装（React Aria PressEvent 无 preventDefault，锚点与按钮分两路写） */
  const anchorScroll = (id: string) => (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault()
    smoothScrollTo(id)
  }

  return (
    <div className="lp-shell" id="top">
      <header className="lp-nav">
        <Link href="#top" className="lp-brand" onClick={anchorScroll('top')}>
          <BrandMark />
          Motif
        </Link>
        {/* 文案映射：开始体验 → 立即生成；导航锚点链接已按用户裁决移除（2026-09-20） */}
        <Button variant="primary" onPress={() => openAuth('login')}>立即生成</Button>
      </header>

      <main>
        <section className="lp-hero">
          {/* banner 图层：desktop 右置 ~52% 渐变融合；tablet/mobile 全幅垫顶（dragonpass 手法，见 globals.css lp-hero 段） */}
          <div className="lp-hero-visual" aria-hidden>
            <img src="/landing/hero-banner.jpg" alt="" />
            <div className="lp-hero-fade" />
          </div>
          {/* 左侧暗色块外扩 4px 盖住接缝防亮线（仅 desktop 出场） */}
          <div className="lp-hero-solid" aria-hidden />
          <div className="lp-container lp-hero-grid">
            <div className="lp-hero-copy">
              <span className="lp-hero-badge">
                <Sparkles aria-hidden />
                Motif · AI 商业图片批量工作台
              </span>
              <h1 className="lp-hero-title">
                一张参考图，
                <br />
                成套产出商业图片
              </h1>
              <p className="lp-hero-sub">
                把你的参考图交给模板，Motif 负责成套出图：商品主图、人像写真、旅拍大片一次到位。
                生成在云端排队进行，不占用本地算力；历史任务随时回看、继续迭代。
              </p>
              <div className="lp-actions">
                {/* 文案映射：立即开始 → 开始生成 */}
                <Button variant="primary" onPress={() => openAuth('login')}>开始生成</Button>
                <Button
                  variant="outline"
                  className="text-[color:var(--lp-hero-fg)] border-[color:color-mix(in_srgb,var(--lp-hero-fg)_45%,transparent)]"
                  onPress={() => smoothScrollTo('showcase')}
                >
                  先看效果
                </Button>
              </div>
              {/* 原先的 ✓ / ✦ 是文字字形冒充图标，2026-09-21 换成图标库 */}
              <div className="lp-hero-points">
                <span><CircleCheck className="me-1 inline align-[-0.125em]" aria-hidden /><SignupBonusPhrase tail="额度" /></span>
                <span><CircleCheck className="me-1 inline align-[-0.125em]" aria-hidden />单任务多张成套</span>
                <span><CircleCheck className="me-1 inline align-[-0.125em]" aria-hidden />云端队列不占本地算力</span>
              </div>
            </div>
          </div>
        </section>

        <section id="showcase" className="lp-band lp-band-showcase">
          <div className="lp-container">
            <h2 className="lp-section-title">一次任务，一套可用素材</h2>
            <p className="lp-section-sub">从参考图分析到批量出图的完整过程，都在任务面板里清晰可见。</p>
            <div className="lp-showcase-grid" style={{ marginTop: 26 }}>
              <div className="lp-demo-card">
                <h3 style={{ fontSize: 16, fontWeight: 700 }}>示例 · 香薰蜡烛上新</h3>
                <p className="mt-2 text-sm" style={{ color: 'var(--muted)', lineHeight: 1.8 }}>
                  以蜡烛实拍图为主体，产出电商详情页素材：白底主图、餐桌场景与材质特写，
                  保持同一支蜡烛的形态与香色氛围。
                </p>
                <div className="mt-3">
                  <div className="lp-step"><span className="lp-step-dot" /><span>已解析参考图主体与光线特征</span></div>
                  <div className="lp-step"><span className="lp-step-dot" /><span>已套用「电商商品全套图」模板</span></div>
                  <div className="lp-step"><span className="lp-step-dot" /><span>4 张图片进入云端队列生成</span></div>
                </div>
              </div>
              <div className="lp-shot">
                <figure>
                  <img src="/templates/ecommerce-suite.jpg" alt="商品套图示例" width={1536} height={1024} />
                  <figcaption>电商商品全套图 · 示例成片</figcaption>
                </figure>
                <figure>
                  <img src="/templates/portrait-editorial.jpg" alt="人物写真示例" width={1536} height={1024} />
                  <figcaption>个人形象写真 · 示例成片</figcaption>
                </figure>
                <figure>
                  <img src="/templates/world-landmarks.jpg" alt="旅拍示例" width={1536} height={1024} />
                  <figcaption>环球地标旅拍 · 示例成片</figcaption>
                </figure>
                <figure>
                  <img src="/templates/wedding-portrait.jpg" alt="婚纱样片示例" width={1536} height={1024} />
                  <figcaption>婚纱旅拍样片 · 示例成片</figcaption>
                </figure>
              </div>
            </div>
          </div>
        </section>

        <section id="features" className="lp-band lp-band-features">
          <div className="lp-container">
            <h2 className="lp-section-title">为什么选 Motif</h2>
            <p className="lp-section-sub">从参考图到成套素材的完整工作流。</p>
            <div className="lp-feature-grid">
              <div className="lp-feature">
                <h3>参考图驱动</h3>
                <p>上传一张商品或人像参考，模板自动对齐主体特征与光影语言，整组出图不跑偏。</p>
              </div>
              <div className="lp-feature">
                <h3>成套批量出图</h3>
                <p>一次任务产出多张、多角度、多场景素材，主图、场景图与特写一次配齐。</p>
              </div>
              <div className="lp-feature">
                <h3>云端队列生成</h3>
                <p>任务在服务端排队执行，关掉页面也不中断，回来直接取图。</p>
              </div>
              <div className="lp-feature">
                <h3>历史沉淀迭代</h3>
                <p>每轮生成自动存档，可以换提示词、换风格在原有基础上继续打磨。</p>
              </div>
            </div>
          </div>
        </section>

        <section className="lp-band lp-band-cta">
          <div className="lp-container lp-cta-inner">
            {/* 完整纹样版印章（含墨色小 m 变奏）：只在 ≥64px 的大画幅出场，
                顶栏/favicon 用减法版 BrandMark，分层约定见 docs/brand/README.md */}
            <img
              src="/brand/motif-logo-editorial.svg"
              alt="Motif 印章"
              width={96}
              height={96}
            />
            <h2 className="lp-section-title">准备好开始了吗？</h2>
            <p className="lp-section-sub"><SignupBonusPhrase tail="生成额度，不需要绑卡。" /></p>
            <Button variant="primary" className="mt-5" onPress={() => openAuth('register')}>免费注册</Button>
          </div>
        </section>
      </main>

      <footer className="lp-footer">
        <span className="lp-brand" style={{ fontSize: 14 }}>
          <BrandMark size={22} />
          Motif
        </span>
        <span>© 2026 Motif · AI 商业图片批量生成工作台</span>
      </footer>

      {authOpen && (
        <AuthModal
          mode={authMode}
          onModeChange={setAuthMode}
          onClose={closeAuth}
          prefill={resetPrefill ?? undefined}
        />
      )}
    </div>
  )
}

export { Landing }
