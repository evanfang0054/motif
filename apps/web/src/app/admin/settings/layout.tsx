import { cookies } from 'next/headers'
import { notFound } from 'next/navigation'
import { SESSION_COOKIE } from '@/server/auth'
import { getRuntime } from '@/server/context'

/**
 * 系统设置段落的 root 独占守卫：管理员与普通用户一律 404。
 *
 * 父级 admin/layout.tsx 只要求 admin 级，因此这一段必须自己再收一次 —— 与 audit 段落同款。
 * 返回 404 而不是 403/重定向：不向非授权者泄露页面的存在性。
 *
 * ⚠️ 与 CLAUDE.md 的注意事项一致：App Router 中 layout 与 page 并行渲染，所以这层是
 * 「404 门」而不是安全边界 —— 真正的边界是 /api/admin/settings 的 requireRoot。
 */
export default async function AdminSettingsLayout({ children }: { children: React.ReactNode }) {
  const token = (await cookies()).get(SESSION_COOKIE)?.value
  const user = token ? getRuntime().store.getUserBySession(token) : null
  if (!user || user.status === 'disabled' || user.role !== 'root') notFound()
  return <>{children}</>
}
