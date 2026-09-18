'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import type { AdminNavItem } from '@/app/admin/nav'

/**
 * 管理后台侧边导航。
 *
 * - ≥1024：常驻左栏（由 CSS 决定，组件不感知断点）
 * - <1024：由**头部右上角的图标按钮**以**左侧抽屉**形式打开，带遮罩；点遮罩 / 点菜单项 / Esc 关闭
 *
 * 客户端组件：管理页必须客户端取数/交互（服务端渲染的内容会随 404 响应的 flight payload 泄露）。
 */
export function AdminSidebar({ items }: { items: AdminNavItem[] }) {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)

  // 抽屉是模态交互：只给鼠标不给键盘是残的，Esc 必须能关
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <>
      {/* 图标按钮：只在 <1024 显示（桌面档由 CSS 隐藏）。文案只留在 aria-label 里，界面只出图标 */}
      <button
        type="button"
        className="admin-nav-toggle"
        aria-expanded={open}
        aria-label={open ? '关闭管理菜单' : '打开管理菜单'}
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden="true">{open ? '✕' : '☰'}</span>
      </button>

      {/* 遮罩：桌面档由 CSS 隐藏；点它关闭抽屉 */}
      <div
        className={open ? 'admin-nav-backdrop is-open' : 'admin-nav-backdrop'}
        onClick={() => setOpen(false)}
        aria-hidden="true"
      />

      <nav className={open ? 'admin-nav is-open' : 'admin-nav'} aria-label="管理后台导航">
        {items.map((it) =>
          it.pending ? (
            <span key={it.href} className="admin-nav-item is-pending" title="即将交付">
              {it.label}
              <em>待交付</em>
            </span>
          ) : (
            <Link
              key={it.href}
              href={it.href}
              className={pathname === it.href ? 'admin-nav-item is-active' : 'admin-nav-item'}
              onClick={() => setOpen(false)}
            >
              {it.label}
            </Link>
          )
        )}
      </nav>
    </>
  )
}
