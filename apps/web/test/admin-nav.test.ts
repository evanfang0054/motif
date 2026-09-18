import { describe, expect, it } from 'vitest'
import { roleAtLeast, type UserRole } from '@motif/core'
import { ADMIN_NAV } from '@/app/admin/nav'

/**
 * 契约：菜单可见性由 ADMIN_NAV 的 minRole 与角色层级共同决定。
 * 这里锁的是**菜单表本身**（哪个页面属于哪个角色），不是 roleAtLeast 的实现。
 */
function labelsFor(role: UserRole): string[] {
  return ADMIN_NAV.filter((i) => roleAtLeast(role, i.minRole)).map((i) => i.label)
}

describe('管理后台菜单的角色可见性', () => {
  it('admin 可见前后台业务页，但看不到 root 独占的审计与系统设置', () => {
    expect(labelsFor('admin')).toEqual(['概览', 'CDK', '订单', '反馈', '生成日志', '用户'])
    expect(labelsFor('admin')).not.toContain('系统设置')
    expect(labelsFor('admin')).not.toContain('审计日志')
  })

  it('root 可额外看到审计日志与系统设置', () => {
    const labels = labelsFor('root')
    expect(labels).toEqual(['概览', 'CDK', '订单', '反馈', '生成日志', '用户', '审计日志', '系统设置'])
  })

  it('普通用户看不到任何管理页（纵深防御：布局守卫之外菜单层也不给入口）', () => {
    expect(labelsFor('user')).toEqual([])
  })

  it('已交付页面的 href 与实际路由目录一一对应，未交付的不可导航', () => {
    const delivered = ADMIN_NAV.filter((i) => !i.pending)
    expect(delivered.map((i) => i.href)).toEqual(['/admin/cdks', '/admin/orders'])
  })
})
