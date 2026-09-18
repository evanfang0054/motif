'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import type { AdminNavItem } from '@/app/admin/nav'

/**
 * 管理后台侧边导航。≥1024 常驻；<1024 收进抽屉，由顶部按钮开关。
 * 客户端组件：管理页必须客户端取数/交互（服务端渲染的内容会随 404 的 flight payload 泄露）。
 */
export function AdminSidebar({ items }: { items: AdminNavItem[] }) {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)

  return (
    <>
      {/* H5 抽屉开关：桌面档由 CSS 隐藏 */}
      <button
        className="admin-nav-toggle"
        aria-expanded={open}
        aria-label="切换管理菜单"
        onClick={() => setOpen((v) => !v)}
      >
        ☰ 菜单
      </button>

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
