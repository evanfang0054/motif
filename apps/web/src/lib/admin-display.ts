import type { AdminUserBrief } from './client'

/**
 * 管理端「把人显示成人」的两个纯函数。
 *
 * 背景（issue #75-3.1）：审计 / 生成日志 / 反馈三页的操作者与用户列过去直出裸 `usr_xxx` ID，
 * 与「回答谁对谁做了什么」的审计定位相悖 —— 人工根本没法把 ID 与真实用户对应起来。
 * 接口现在附带当页引用到的用户摘要（`users`），由这里负责渲染。
 */

/** 把接口返回的摘要数组收成 `id → 摘要` 的 Map；缺字段/重复都容错 */
export function userBriefMap(users: readonly AdminUserBrief[] | undefined): Map<string, AdminUserBrief> {
  const map = new Map<string, AdminUserBrief>()
  for (const u of users ?? []) {
    if (u && typeof u.id === 'string' && u.id) map.set(u.id, u)
  }
  return map
}

/**
 * 展示一个用户：优先「昵称（邮箱）」，拿不到摘要时**退回裸 ID**。
 *
 * 为什么必须有兜底：摘要只覆盖当页引用到的 id。若将来某行引用了一个查不到的 id
 * （用户被清理、映射遗漏），显示空串会让整行看起来像坏了；退回 ID 至少还能追溯。
 *
 * 昵称等于邮箱时只显示一次（引导创建的账号 name 就是邮箱，拼成「a@b.co（a@b.co）」很怪）。
 */
export function userDisplayLabel(user: AdminUserBrief | undefined | null, fallbackId: string): string {
  const name = user?.name?.trim() ?? ''
  const email = user?.email?.trim() ?? ''
  if (name && email) return name === email ? email : `${name}（${email}）`
  return name || email || fallbackId
}
