import type { MotifStore } from '@motif/db'
import {
  DEFAULT_INVITE_REWARD_CREDITS,
  DEFAULT_INVITE_REWARD_MAX_INVITEES,
  DEFAULT_SIGNUP_BONUS_CREDITS,
} from '@motif/core'
import { resolveBool, resolveConfigValues } from './settings'

/**
 * 面向**未登录用户**的公开配置白名单。
 *
 * ⚠️ **显式列举，禁止改成「非密钥即公开」的批量放行** —— 那种写法一旦新增了语义上
 * 不该外露的键（各类开关、内部地址等），会静默泄漏，且没人会注意到白名单「变宽了」。
 * 加键时必须同时在本数组与 PublicConfig 接口里各写一次，让泄漏需要一次显式动作。
 */
export const PUBLIC_CONFIG_KEYS = [
  'INVITE_REWARD_ENABLED',
  'INVITE_REWARD_CREDITS',
  'INVITE_REWARD_MAX_INVITEES',
  'SIGNUP_BONUS_CREDITS',
] as const

export interface PublicConfig {
  inviteRewardEnabled: boolean
  inviteRewardCredits: number
  inviteRewardMaxInvitees: number
  signupBonusCredits: number
}

/** 数值类键非法（非整数 / 小于 1）时回退默认值 —— 脏配置不该影响注册链路 */
function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw)
  return Number.isInteger(n) && n >= 1 ? n : fallback
}

/** 读公开配置。只回白名单里的非密钥值。 */
export function readPublicConfig(store: MotifStore, env: Record<string, string | undefined>): PublicConfig {
  const v = resolveConfigValues(store, env)
  return {
    inviteRewardEnabled: resolveBool(store, env, 'INVITE_REWARD_ENABLED', false),
    inviteRewardCredits: positiveInt(v.INVITE_REWARD_CREDITS, DEFAULT_INVITE_REWARD_CREDITS),
    inviteRewardMaxInvitees: positiveInt(v.INVITE_REWARD_MAX_INVITEES, DEFAULT_INVITE_REWARD_MAX_INVITEES),
    signupBonusCredits: positiveInt(v.SIGNUP_BONUS_CREDITS, DEFAULT_SIGNUP_BONUS_CREDITS),
  }
}
