'use client'

import { useRouter } from 'next/navigation'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import { Drawer, ListBox } from '@heroui/react'
import { Bars } from '@gravity-ui/icons'
import type { AdminNavItem } from '@/app/admin/nav'

/**
 * 管理后台侧边导航（heroui-migration P3 复查：整体迁至 HeroUI）。
 *
 * - ≥1024：常驻左栏（由 CSS 决定断点），ListBox 单选语义 = 当前页高亮
 * - <1024：头部图标按钮打开 HeroUI Drawer（左侧抽屉），遮罩 / ✕ / 选菜单项关闭
 *
 * 客户端组件：管理页必须客户端取数/交互（服务端渲染的内容会随 404 响应的 flight payload 泄露）。
 */
export function AdminSidebar({ items }: { items: AdminNavItem[] }) {
  const pathname = usePathname()
  const router = useRouter()
  const [open, setOpen] = useState(false)

  function pick(key: unknown) {
    if (typeof key !== 'string') return
    setOpen(false)
    router.push(key)
  }

  const navList = (onPick: () => void) => (
    <ListBox
      aria-label="管理后台导航"
      selectionMode="single"
      selectedKeys={new Set([pathname])}
      onSelectionChange={(keys) => {
        pick([...keys][0])
        onPick()
      }}
      className="admin-nav-list"
    >
      {items.map((it) =>
        it.pending ? (
          <ListBox.Item key={it.href} id={it.href} isDisabled className="admin-nav-item is-pending">
            {it.label}
            <em>待交付</em>
          </ListBox.Item>
        ) : (
          <ListBox.Item key={it.href} id={it.href} className="admin-nav-item">
            {it.label}
          </ListBox.Item>
        ),
      )}
    </ListBox>
  )

  return (
    <>
      {/* 图标按钮：只在 <1024 显示（桌面档由 CSS 隐藏）。打开 HeroUI 左侧抽屉 */}
      {/* ☰ 原为文字字形，2026-09-21 换成图标库的 Bars */}
      <button
        type="button"
        className="admin-nav-toggle"
        aria-label="打开管理菜单"
        onClick={() => setOpen(true)}
      >
        <Bars aria-hidden="true" />
      </button>

      <Drawer.Backdrop isOpen={open} onOpenChange={setOpen}>
        <Drawer.Content placement="left">
          <Drawer.Dialog>
            <Drawer.Header>
              <Drawer.Heading>管理菜单</Drawer.Heading>
              <Drawer.CloseTrigger aria-label="关闭管理菜单" />
            </Drawer.Header>
            <Drawer.Body>{navList(() => setOpen(false))}</Drawer.Body>
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>

      <nav className="admin-nav" aria-label="管理后台导航">
        {navList(() => undefined)}
      </nav>
    </>
  )
}
