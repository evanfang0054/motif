import type { MotifStore } from '@motif/db'
import {
  DEFAULT_INVITE_REWARD_CREDITS,
  DEFAULT_INVITE_REWARD_MAX_INVITEES,
  DEFAULT_SIGNUP_BONUS_CREDITS,
} from '@motif/core'
import { resolveBool, resolvePositiveInt } from './settings'

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
  // 前端据此决定是否请求提示词增强（只暴露布尔，不暴露端点/密钥）
  'LLM_ENHANCE_ENABLED',
  // 两个功能开关：前端据此隐藏入口。**服务端各自也把一道**（下单 / 兑换接口），
  // 前端隐藏只是体验，不是防线 —— 关掉开关后直接打接口同样会被拒。
  'BILLING_ENABLED',
  'CDK_REDEEM_ENABLED',
  // 注册入口开关：前端据此隐藏注册入口。**服务端各自也把一道**（register / send-code），
  // 前端隐藏只是体验，不是防线。
  'REGISTRATION_ENABLED',
  // 注册是否要求邮箱验证码：前端据此隐藏验证码行与发送按钮。
  // 代价是向匿名访客暴露「本站不要求邮箱验证码」—— 这一信息一次注册尝试即可探测到，
  // 隐藏它不产生安全收益，却会让前端 UX 分叉（用户提交后才知道不用填验证码）。
  'REGISTRATION_REQUIRE_EMAIL_CODE',
] as const

export interface PublicConfig {
  inviteRewardEnabled: boolean
  inviteRewardCredits: number
  inviteRewardMaxInvitees: number
  signupBonusCredits: number
  llmEnhanceEnabled: boolean
  billingEnabled: boolean
  cdkRedeemEnabled: boolean
  registrationEnabled: boolean
  registrationRequireEmailCode: boolean
}

/** 读公开配置。只回白名单里的非密钥值；数值类键非法时回退默认值（口径与注册链路共用 resolvePositiveInt）。 */
export function readPublicConfig(store: MotifStore, env: Record<string, string | undefined>): PublicConfig {
  return {
    inviteRewardEnabled: resolveBool(store, env, 'INVITE_REWARD_ENABLED', false),
    inviteRewardCredits: resolvePositiveInt(store, env, 'INVITE_REWARD_CREDITS', DEFAULT_INVITE_REWARD_CREDITS),
    inviteRewardMaxInvitees: resolvePositiveInt(
      store,
      env,
      'INVITE_REWARD_MAX_INVITEES',
      DEFAULT_INVITE_REWARD_MAX_INVITEES,
    ),
    signupBonusCredits: resolvePositiveInt(store, env, 'SIGNUP_BONUS_CREDITS', DEFAULT_SIGNUP_BONUS_CREDITS),
    llmEnhanceEnabled: resolveBool(store, env, 'LLM_ENHANCE_ENABLED', false),
    // ⚠️ 兜底值必须与 SETTING_DEFS 的 defaultHint、以及服务端两处 `resolveBool` 的兜底一致：
    // 三处各写一份就是三次漂移机会（前端按 true 显示入口、服务端按 false 拒绝，用户只会看到「点了报错」）。
    billingEnabled: resolveBool(store, env, 'BILLING_ENABLED', false),
    cdkRedeemEnabled: resolveBool(store, env, 'CDK_REDEEM_ENABLED', true),
    // 兜底值必须与 SETTING_DEFS 的 defaultHint 一致（三处各写一份就是三次漂移机会）
    registrationEnabled: resolveBool(store, env, 'REGISTRATION_ENABLED', true),
    registrationRequireEmailCode: resolveBool(store, env, 'REGISTRATION_REQUIRE_EMAIL_CODE', true),
  }
}
