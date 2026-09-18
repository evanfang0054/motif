import { cookies } from 'next/headers'
import { notFound } from 'next/navigation'
import { roleAtLeast } from '@motif/core'
import { SESSION_COOKIE } from '@/server/auth'
import { getRuntime } from '@/server/context'

/**
 * 审计段的角色守卫：非 root 一律 404（与「普通用户访问 /admin 得 404」同一层级）。
 *
 * ⚠️ 这仍是**404 门**，不是安全边界 —— App Router 里 segment layout 与 page 并行渲染，
 * page 的服务端文本仍会进 404 响应的 RSC flight payload。真正的边界是 `/api/admin/audit`
 * 上的 `requireRoot`；审计页必须是客户端组件、数据走那个接口。
 */
export default async function AuditLayout({ children }: { children: React.ReactNode }) {
  const token = (await cookies()).get(SESSION_COOKIE)?.value
  const user = token ? getRuntime().store.getUserBySession(token) : null
  if (!user || user.status === 'disabled' || !roleAtLeast(user.role, 'root')) notFound()
  return <>{children}</>
}
