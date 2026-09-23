import type { Metadata, Viewport } from 'next'
import './globals.css'
import { ToastProvider } from '@/components/ui/ToastProvider'
import { ThemeWatcher } from '@/components/ThemeWatcher'
import { THEME_INIT_SCRIPT } from '@/lib/theme'

export const metadata: Metadata = {
  title: 'Motif · AI 商业图片批量生成工作台',
  description: 'AI 商业图片批量生成工作台：参考图驱动、模板成套出图、云端排队、额度计费。',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
}

const THEME_INIT = THEME_INIT_SCRIPT

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    /**
     * suppressHydrationWarning：<html> 的属性会在水合前被改写，属预期行为，有两类来源
     * 1) 下方 THEME_INIT 内联脚本按 localStorage 写入 data-theme（防首帧闪烁的必要代价）
     * 2) 浏览器扩展（如沉浸式翻译）注入 data-immersive-translate-* 属性
     * 二者都会让 React 报「服务端属性与客户端不一致」。该出口只作用于本元素的属性，
     * 不影响子树的水合校验。
     */
    <html lang="zh-CN" className="h-full" suppressHydrationWarning>
      <body className="min-h-full antialiased">
        {/* 首帧主题解析：默认浅色；读取 localStorage 三态，防闪烁 */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
        {/* 运行期主题跟随（系统明暗实时变化）：必须挂在**常驻层** —— 见 ThemeWatcher 的说明。
            放在这里而不是工作台的顶栏里，是因为落地页 / 管理后台同样需要「跟随系统」生效。 */}
        <ThemeWatcher />
        <ToastProvider />
        {children}
      </body>
    </html>
  )
}
