import type { UserRole } from './types'

/** 角色层级：user < admin < root。全仓角色比较只走这里，禁止散落字符串比较 */
const ROLE_RANK: Record<UserRole, number> = { user: 0, admin: 1, root: 2 }

/** 判断角色是否达到所需层级 */
export function roleAtLeast(role: UserRole, required: UserRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[required]
}
