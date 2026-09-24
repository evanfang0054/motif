import { cookies } from 'next/headers'
import Link from 'next/link'
import { ArrowLeft } from '@gravity-ui/icons'
import { notFound } from 'next/navigation'
import { roleAtLeast } from '@motif/core'
import { SESSION_COOKIE } from '@/server/auth'
import { getRuntime } from '@/server/context'
import { resolveAdminSessionState } from '@/server/admin-session'
import { AdminSidebar } from '@/components/admin/AdminSidebar'
import { ADMIN_NAV } from './nav'
import './admin.css'
import { InlineText } from '@/components/ui/typography'

/**
 * 管理面服务端守卫。裁决逻辑抽在 `server/admin-session.ts`（纯函数、可单测），
 * 这里只负责读 cookie 与把三种结果映射成 UI：可访问 / 过期引导 / 404。
 */
async function getAdminSession() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value
  return resolveAdminSessionState(getRuntime().store, token)
}

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getAdminSession()
  if (session.kind === 'expired') return <AdminSessionExpired />
  if (session.kind === 'unauthorized') notFound()
  const user = session.user
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

/**
 * 会话过期引导页。
 *
 * 不渲染 `children`：那些是客户端取数的管理页，此时它们的接口必然 401，
 * 渲染出来只会叠一层「请求失败」的噪音。也不含任何管理数据，故服务端渲染无泄露面。
 * 登录入口是 `/`（Landing 内含登录/注册），与管理后台的「返回工作台」指向同一个位置。
 */
function AdminSessionExpired() {
  return (
    <div className="admin-shell">
      <header className="admin-header">
        <div className="admin-header-left">
          <InlineText style={{ color: 'var(--foreground)' }} type="body-sm" className="admin-brand">Motif 管理后台</InlineText>
        </div>
      </header>
      <main className="admin-main">
        <section className="admin-panel">
          <h1 className="admin-title">登录已过期</h1>
          <p className="admin-muted" role="alert">
            当前会话已失效，无法继续访问管理后台。请重新登录后再进入（重新登录后直接回到原页面即可）。
          </p>
          <div className="admin-actions" style={{ marginTop: 14 }}>
            {/* .admin-btn-primary 原本只给 <button> 用，<a> 是行内元素、上下 padding 不生效，
                故补 display 与去下划线（走 Tailwind 工具类，不往 admin.css 加控件样式） */}
            <Link href="/" className="admin-btn-primary inline-block no-underline">去登录</Link>
          </div>
        </section>
      </main>
    </div>
  )
}
