'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { BrandMark } from '@/components/BrandMark'
import { AuthCard, type Mode } from './AuthCard'

/** 未登录落地页：导航 + 主视觉 + 登录卡 + 案例 + 功能 + 页脚 */
function Landing() {
  // 默认登录模式（回访/老用户主路径）；「免费注册」「注册送额度」等注册意图入口显式切换
  const [authMode, setAuthMode] = useState<Mode>('login')

  // URL 入口：/?mode=register（投放外链）、/?mode=login（显式登录）、/?invite=CODE（邀请自动注册）
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const mode = params.get('mode')
    if (mode === 'register' || mode === 'login') setAuthMode(mode)
    if (params.get('invite')) setAuthMode('register')
  }, [])

  /** 注册意图 CTA：切到注册模式并滚动到卡片 */
  const goRegister = (e: React.MouseEvent<HTMLAnchorElement>) => {
    setAuthMode('register')
    e.preventDefault()
    document.getElementById('auth')?.scrollIntoView({ behavior: 'smooth' })
  }

  /** 登录意图 CTA：确保卡片处于登录模式 */
  const goLogin = () => setAuthMode('login')

  return (
    <div className="lp-shell" id="top">
      <header className="lp-nav">
        <Link href="#top" className="lp-brand">
          <BrandMark />
          Motif
        </Link>
        <nav className="lp-nav-links hidden md:flex">
          <a href="#showcase">案例一览</a>
          <a href="#features">核心能力</a>
          <a href="#auth" onClick={goRegister}>注册送额度</a>
        </nav>
        <a className="lp-btn lp-btn-primary" href="#auth" onClick={goLogin}>开始体验</a>
      </header>

      <main className="lp-main">
        <section className="lp-hero">
          <div>
            <span className="lp-hero-badge">✦ Motif · AI 商业图片批量工作台</span>
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
              <a className="lp-btn lp-btn-primary" href="#auth" onClick={goLogin}>立即开始</a>
              <a className="lp-btn lp-btn-ghost" href="#showcase">先看效果</a>
            </div>
            <div className="lp-hero-points">
              <span>✓ 注册即送 3 张额度</span>
              <span>✓ 单任务多张成套</span>
              <span>✓ 云端队列不占本地算力</span>
            </div>
          </div>
          <AuthCard mode={authMode} onModeChange={setAuthMode} />
        </section>

        <section id="showcase" className="lp-showcase">
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
                <img src="/templates/ecommerce-suite.svg" alt="商品套图示例" width={1448} height={1086} />
                <figcaption>主图 1448×1086</figcaption>
              </figure>
              <figure>
                <img src="/templates/portrait-editorial.svg" alt="人物写真示例" width={1024} height={1536} />
                <figcaption>写真 1024×1536</figcaption>
              </figure>
              <figure>
                <img src="/templates/world-landmarks.svg" alt="旅拍示例" width={1402} height={1122} />
                <figcaption>旅拍 1402×1122</figcaption>
              </figure>
              <figure>
                <img src="/templates/wedding-portrait.svg" alt="婚纱样片示例" width={1024} height={1536} />
                <figcaption>样片 1024×1536</figcaption>
              </figure>
            </div>
          </div>
        </section>

        <section id="features" className="lp-features">
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
        </section>

        <section className="lp-showcase" style={{ paddingBottom: 80 }}>
          <div className="lp-card" style={{ textAlign: 'center' }}>
            <h2 className="lp-section-title">准备好开始了吗？</h2>
            <p className="lp-section-sub">注册即送 3 张生成额度，不需要绑卡。</p>
            <a className="lp-btn lp-btn-primary mt-5" href="#auth" onClick={goRegister}>免费注册</a>
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
    </div>
  )
}

export { Landing }
