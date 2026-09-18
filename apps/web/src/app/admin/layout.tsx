import { cookies } from 'next/headers'
import { notFound } from 'next/navigation'
import { roleAtLeast } from '@motif/core'
import { SESSION_COOKIE } from '@/server/auth'
import { getRuntime } from '@/server/context'
import './admin.css'

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
  return (
    <div className="admin-shell">
      <header className="admin-header">
        <span className="admin-brand">Motif 管理后台</span>
        <span className="admin-identity">
          {user.name}
          {showRole ? `（${roleLabel}）` : ''}
        </span>
      </header>
      <main className="admin-main">{children}</main>
    </div>
  )
}
