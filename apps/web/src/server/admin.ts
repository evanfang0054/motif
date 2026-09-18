import type { NextRequest } from 'next/server'
import { roleAtLeast, type User, type UserRole } from '@motif/core'
import { SESSION_COOKIE } from './auth'
import { getRuntime } from './context'
import { ServiceError } from './services'

/**
 * 管理面鉴权：角色层级 user < admin < root。
 * 页面层守卫见 app/admin/layout.tsx；此处是接口层守卫，两层独立校验。
 *
 * 刻意不从 ./http 引入 currentUser：http.ts 顶层对 next/server 做值导入，
 * 运行时加载它会拖入 Next 运行时依赖。此处只做类型导入并内联会话解析。
 */
function resolveUser(req: NextRequest): User | null {
  const token = req.cookies.get(SESSION_COOKIE)?.value
  if (!token) return null
  return getRuntime().store.getUserBySession(token)
}

export function requireRole(req: NextRequest, required: UserRole): User {
  const user = resolveUser(req)
  if (!user) throw new ServiceError(401, '请先登录。')
  if (user.status === 'disabled') throw new ServiceError(403, '账号已被禁用。')
  if (!roleAtLeast(user.role, required)) throw new ServiceError(403, '无权限执行该操作。')
  return user
}

export function requireAdmin(req: NextRequest): User {
  return requireRole(req, 'admin')
}

export function requireRoot(req: NextRequest): User {
  return requireRole(req, 'root')
}

// ---------- 角色保护规则 ----------

/**
 * 管理员不得改动超级管理员；系统不得失去最后一个超级管理员。
 *
 * 注意：这是**服务层契约**。store 的 updateUserRole / setUserStatus 是不加保护的裸更新，
 * 因此任何修改角色或启用状态的接口都必须先调用本断言。
 */
export function assertCanModifyRole(actor: User, target: User, nextRole: UserRole): void {
  if (actor.id !== target.id && actor.role === 'admin' && target.role === 'root') {
    throw new ServiceError(403, '管理员不可修改超级管理员的角色。')
  }
  // 授予超级管理员同样是提权面：否则管理员可通过「先加一个 root，再降级原 root」架空最后 root 保护
  if (actor.role === 'admin' && nextRole === 'root') {
    throw new ServiceError(403, '仅超级管理员可授予超级管理员角色。')
  }
  if (target.role === 'root' && nextRole !== 'root') assertNotLastRoot('降级')
}

/** 禁用同样受保护：不得禁用超级管理员，也不得禁用最后一个超级管理员 */
export function assertCanDisable(actor: User, target: User): void {
  if (actor.id !== target.id && actor.role === 'admin' && target.role === 'root') {
    throw new ServiceError(403, '管理员不可禁用超级管理员账号。')
  }
  if (target.role === 'root') assertNotLastRoot('禁用')
}

/** 目标本身是 root，若系统中 root 总数 <= 1，操作后就没有超级管理员了 */
function assertNotLastRoot(verb: string): void {
  if (getRuntime().store.countUsersByRole('root') <= 1) {
    throw new ServiceError(403, `系统必须保留至少一个超级管理员，无法${verb}最后一个。`)
  }
}

// ---------- 审计 ----------

const MAX_DETAIL_LENGTH = 2000

/**
 * 写审计流水。**失败只告警，不阻断主操作** ——
 * 审计是辅助能力，不应让被包裹的管理动作失败。
 */
export function writeAudit(input: {
  actorId: string
  action: string
  targetType?: string
  targetId?: string
  detail?: unknown
}): void {
  try {
    let raw: string | null = null
    if (input.detail !== undefined) {
      const json = JSON.stringify(input.detail)
      raw = json.length > MAX_DETAIL_LENGTH ? json.slice(0, MAX_DETAIL_LENGTH) : json
    }
    getRuntime().store.insertAudit({
      actorId: input.actorId,
      action: input.action,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      detail: raw,
    })
  } catch (e) {
    console.error('[motif] 审计写入失败（主操作不受影响）:', e)
  }
}
