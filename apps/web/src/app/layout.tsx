import type { Metadata, Viewport } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Motif · AI 商业图片批量生成工作台',
  description: 'AI 商业图片批量生成工作台：参考图驱动、模板成套出图、云端排队、额度计费。',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
}

const THEME_INIT = `(function(){try{var m=localStorage.getItem('motif-theme')||'light';var d=m==='dark'||(m==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);if(d)document.documentElement.dataset.theme='dark';else delete document.documentElement.dataset.theme}catch(e){}})()`

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" className="h-full">
      <body className="min-h-full antialiased">
        {/* 首帧主题解析：默认浅色；读取 localStorage 三态，防闪烁 */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
        {children}
      </body>
    </html>
  )
}
