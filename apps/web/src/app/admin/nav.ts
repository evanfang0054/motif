import type { UserRole } from '@motif/core'

/** 管理后台菜单项。放在非路由文件里：路由模块的导出受 Next 白名单约束，不能挂业务常量。 */
export interface AdminNavItem {
  href: string
  label: string
  minRole: UserRole
  /** true = 该页在后续计划中交付，当前只占位不导航 */
  pending?: boolean
}

export const ADMIN_NAV: AdminNavItem[] = [
  { href: '/admin', label: '概览', minRole: 'admin' },
  { href: '/admin/cdks', label: 'CDK', minRole: 'admin' },
  { href: '/admin/orders', label: '订单', minRole: 'admin' },
  { href: '/admin/feedback', label: '反馈', minRole: 'admin' },
  { href: '/admin/logs', label: '生成日志', minRole: 'admin', pending: true },
  { href: '/admin/users', label: '用户', minRole: 'admin', pending: true },
  { href: '/admin/audit', label: '审计日志', minRole: 'root' },
  { href: '/admin/settings', label: '系统设置', minRole: 'root', pending: true },
]
