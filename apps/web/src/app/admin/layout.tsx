import { cookies } from 'next/headers'
import Link from 'next/link'
import { ArrowLeft } from '@gravity-ui/icons'
import { notFound } from 'next/navigation'
import { roleAtLeast } from '@motif/core'
import { SESSION_COOKIE } from '@/server/auth'
import { getRuntime } from '@/server/context'
import { AdminSidebar } from '@/components/admin/AdminSidebar'
import { ADMIN_NAV } from './nav'
import './admin.css'
import { InlineText } from '@/components/ui/typography'

/**
 * 管理面服务端守卫：未登录、被禁用、角色不足一律 notFound()。
 * 返回 404 而非 403/重定向 —— 不向普通用户泄露管理面的存在性。
 */
async function getAdminUser() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value
  if (!token) return null
  const user = getRuntime().store.getUserBySession(token)
  if (!user || user.status === 'disabled') return null
  if (!roleAtLeast(user.role, 'admin')) return null
  return user
}

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await getAdminUser()
  if (!user) notFound()
  const roleLabel = user.role === 'root' ? '超级管理员' : '管理员'
  // 引导创建的账号 name 就是「超级管理员」，此时再拼角色会得到「超级管理员（超级管理员）」
  const showRole = user.name !== roleLabel
  const items = ADMIN_NAV.filter((i) => roleAtLeast(user.role, i.minRole))
  return (
    <div className="admin-shell">
      <header className="admin-header">
        <div className="admin-header-left">
          {/* 管理后台只能从工作台进入（守卫要求已登录），故返回目标固定为工作台；
              用固定链接而非 history.back()，这样直接输入地址进来时也不会走空 */}
          <Link href="/" className="admin-back" title="返回工作台">
            <ArrowLeft className="me-1 inline align-[-0.125em]" aria-hidden />
            返回工作台
          </Link>
          <InlineText style={{ color: 'var(--foreground)' }} type="body-sm" className="admin-brand">Motif 管理后台</InlineText>
        </div>
        <InlineText type="body-sm" className="admin-identity">
          {user.name}
          {showRole ? `（${roleLabel}）` : ''}
        </InlineText>
      </header>
      <div className="admin-body">
        <AdminSidebar items={items} />
        <main className="admin-main">{children}</main>
      </div>
    </div>
  )
}
