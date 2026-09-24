import { roleAtLeast, type User } from '@motif/core'
import type { MotifStore } from '@motif/db'

/**
 * 管理面页面守卫的**裁决函数**（与 Next 运行时解耦，便于单测）。
 *
 * 三种结果：
 *  - `{ kind: 'ok', user }`：可访问
 *  - `{ kind: 'expired' }`：**曾经持有真实会话、只是过期了** → 给「登录已过期」引导（#75-3.4）
 *  - `{ kind: 'unauthorized' }`：未登录 / 无此会话 / 被禁用 / 角色不足 → 调用方 notFound()（404）
 *
 * ⚠️ 为什么「过期」要单独分一档：会话过期后刷新子页原本只得 Next 默认英文 404，
 * 用户完全不知道发生了什么。但也不能对所有无效 cookie 都给引导 —— 那会向探路者
 * 泄露管理面的存在性。判据因此是「sessions 表里还留着这一行且已过期」：
 * 只有真的登录过的人才会命中，且还要再满足「该账号仍是管理员、未被禁用」才给引导。
 */
export type AdminSessionState = { kind: 'ok'; user: User } | { kind: 'expired' } | { kind: 'unauthorized' }

export function resolveAdminSessionState(store: MotifStore, token: string | undefined | null): AdminSessionState {
  if (!token) return { kind: 'unauthorized' }
  const user = store.getUserBySession(token)
  if (!user) {
    // 会话行还在但已过期：只有「曾经登录过的管理员」才给引导，其余一律 404
    const expired = store.getExpiredSessionUser(token)
    if (expired && expired.status !== 'disabled' && roleAtLeast(expired.role, 'admin')) return { kind: 'expired' }
    return { kind: 'unauthorized' }
  }
  if (!roleAtLeast(user.role, 'admin')) return { kind: 'unauthorized' }
  return { kind: 'ok', user }
}
